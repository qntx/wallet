/**
 * The spark module's method table and wire validators. The protocol stays free of @qntx/spark
 * imports — even types — so the signer shapes it validates are declared here structurally; a
 * type-level test in packages/wallet/tests pins them assignable to and from @qntx/spark/signer's
 * types.
 *
 * Every method carries `account` — walletId/groupIndex/network — and is session-gated but not
 * presence-bearing (signer work must not hold a session open). List params are capped at MAX_BATCH;
 * the leaf lists of prepareTransfer/prepareClaim are capped at the signer's own 256.
 */
import { factor, groupIndex, MAX_BATCH, safeTime, walletId } from "./core.ts";
import type { Factor } from "./core.ts";
import type { MethodSpec } from "./index.ts";
import type { Validator } from "./validate.ts";
import {
  arr,
  bytes,
  int,
  literal,
  obj,
  opt,
  record,
  str,
  union,
  ValidationError,
} from "./validate.ts";

/** The Spark network the account's signer runs on — identical to @qntx/spark's SparkNetwork. */
export type SparkNetwork = "mainnet" | "regtest";

/** The wallet+group+network triple every spark.* request addresses a pooled signer by. */
export type SparkAccountRef = {
  readonly walletId: string;
  readonly groupIndex: number;
  readonly network: SparkNetwork;
};

export type SparkLeafKey =
  | { readonly type: "leaf"; readonly leafId: string }
  | { readonly type: "static-deposit"; readonly index: number };

export type SparkKey =
  | SparkLeafKey
  | { readonly type: "received"; readonly ciphertext: Uint8Array };

export type SigningCommitment = {
  readonly hiding: Uint8Array;
  readonly binding: Uint8Array;
};

export type OperatorCommitment = {
  readonly identifier: string;
  readonly commitment: SigningCommitment;
};

export type SigningTarget = {
  readonly transaction: Uint8Array;
  readonly inputIndex: number;
  readonly prevouts: ReadonlyArray<{
    script: Uint8Array;
    amount: number;
  }>;
};

export type FrostSignJob = {
  readonly key: SparkKey;
  readonly target: SigningTarget;
  readonly verifyingKey: Uint8Array;
  readonly commitment: SigningCommitment;
  readonly operatorCommitments: ReadonlyArray<OperatorCommitment>;
  readonly adaptorPublicKey?: Uint8Array;
  /** Connector-refund proof pair — see `FrostSignJob.exit` in @qntx/spark/signer. */
  readonly exit?: {
    readonly connectorTx: Uint8Array;
    readonly exitTx: Uint8Array;
  };
};

export type FrostAggregateJob = {
  readonly key: SparkKey;
  readonly target: SigningTarget;
  readonly verifyingKey: Uint8Array;
  readonly commitment: SigningCommitment;
  readonly signatureShare: Uint8Array;
  readonly operators: ReadonlyArray<{
    readonly identifier: string;
    readonly commitment: SigningCommitment;
    readonly signatureShare: Uint8Array;
    readonly publicKey: Uint8Array;
  }>;
  readonly adaptorPublicKey?: Uint8Array;
};

export type StaticDepositClaimStatement = {
  readonly kind: "static-deposit-claim";
  readonly network: SparkNetwork;
  readonly txid: Uint8Array;
  readonly vout: number;
  readonly creditAmountSats: number;
  readonly sspSignature: Uint8Array;
};

export type IdentityStatement =
  | { readonly kind: "so-challenge"; readonly challenge: Uint8Array }
  | { readonly kind: "ssp-challenge"; readonly protectedChallenge: string }
  | { readonly kind: "transfer-package"; readonly transferId: string; readonly package: Uint8Array }
  | { readonly kind: "claim-package"; readonly transferId: string; readonly package: Uint8Array }
  | StaticDepositClaimStatement
  | {
      readonly kind: "static-deposit-refund";
      readonly network: SparkNetwork;
      readonly txid: Uint8Array;
      readonly vout: number;
      readonly amount: number;
      readonly target: SigningTarget;
    }
  | {
      readonly kind: "watchtower-recovery";
      readonly network: SparkNetwork;
      readonly leafId: string;
      readonly target: SigningTarget;
    }
  | { readonly kind: "spark-invoice"; readonly invoice: Uint8Array }
  | { readonly kind: "token-transaction"; readonly partialTransaction: Uint8Array }
  | {
      readonly kind: "lightning-address";
      readonly action: "register";
      readonly domain: string;
      readonly username: string;
      readonly description: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "lightning-address";
      readonly action: "unregister";
      readonly domain: string;
      readonly username: string;
      readonly timestamp: number;
    };

export type PrepareTransferRequest = {
  readonly transferId: string;
  readonly leaves: ReadonlyArray<{
    readonly leafId: string;
    readonly key: SparkLeafKey;
    readonly receiverIdentityPublicKey: Uint8Array;
  }>;
};

export type PreparedTransferLeaf = {
  readonly leafId: string;
  readonly newPublicKey: Uint8Array;
  readonly secretCipher: Uint8Array;
  readonly signature: Uint8Array;
};

export type PreparedTransfer = {
  readonly operatorPackages: Record<string, Uint8Array>;
  readonly leaves: ReadonlyArray<PreparedTransferLeaf>;
};

export type PrepareClaimRequest = {
  readonly transferId: string;
  readonly leaves: ReadonlyArray<{
    readonly leafId: string;
    readonly secretCipher: Uint8Array;
  }>;
};

export type PreparedClaim = {
  readonly operatorPackages: Record<string, Uint8Array>;
};

export type PreparedLightningReceive = {
  readonly paymentHash: Uint8Array;
  readonly operatorPackages: Record<string, Uint8Array>;
};

export type HtlcTimeoutSignRequest = {
  readonly transaction: Uint8Array;
  readonly inputIndex: number;
  readonly prevoutAmountSats: number;
  readonly paymentHash: Uint8Array;
  readonly hashLockPublicKey: Uint8Array;
};

export type StaticDepositClaimRequest = {
  readonly index: number;
  readonly statement: StaticDepositClaimStatement;
};

export type StaticDepositClaimResult = {
  readonly encryptedSecretKey: Uint8Array;
  readonly signature: Uint8Array;
};

// Field bounds. Where @qntx/spark/signer constrains a value the same rule is mirrored (64-hex
// identifiers, 32/33/64-byte keys and signatures, 1..MAX_BATCH counts); where it leaves a value
// unbounded (leafId/transferId are hashed as UTF-8, ciphertexts and protobuf blobs are bytes) the
// protocol still needs a size — the MAX_REQUEST_BYTES envelope cap makes these generous bounds
// sufficient rather than security-critical.
const MAX_LEAVES = 256;
const MAX_OPERATORS = 16;
const MAX_PACKAGE_BYTES = 1_048_576;
const MAX_TX_BYTES = 1_048_576;
const MAX_PREVOUTS = 1024;
const MAX_SCRIPT_BYTES = 16_384;
const MAX_CIPHERTEXT_BYTES = 4096;
const MAX_SATS = 2_100_000_000_000_000; // 21M BTC in sats

const network: Validator<SparkNetwork> = union(literal("mainnet"), literal("regtest"));
const account: Validator<SparkAccountRef> = obj({ walletId, groupIndex, network });

const identifier: Validator<string> = str(64, /^[0-9a-f]{64}$/);
const leafId: Validator<string> = str(64);
const transferId: Validator<string> = str(64);
const bytes32: Validator<Uint8Array> = bytes(32);
const bytes33: Validator<Uint8Array> = bytes(33);
const bytes64: Validator<Uint8Array> = bytes(64);
const ciphertext: Validator<Uint8Array> = bytes(1, MAX_CIPHERTEXT_BYTES);
const sats: Validator<number> = int(0, MAX_SATS);

const sparkLeafKey: Validator<SparkLeafKey> = union(
  obj({ type: literal("leaf"), leafId }),
  obj({ type: literal("static-deposit"), index: int(0, 0x7fffffff) }),
);

const sparkKey: Validator<SparkKey> = union(
  obj({ type: literal("leaf"), leafId }),
  obj({ type: literal("static-deposit"), index: int(0, 0x7fffffff) }),
  obj({ type: literal("received"), ciphertext }),
);

const signingCommitment: Validator<SigningCommitment> = obj({
  hiding: bytes33,
  binding: bytes33,
});

const operatorCommitment: Validator<OperatorCommitment> = obj({
  identifier,
  commitment: signingCommitment,
});

const signingTarget: Validator<SigningTarget> = obj({
  transaction: bytes(1, MAX_TX_BYTES),
  inputIndex: int(0, 0x7fffffff),
  prevouts: arr(obj({ script: bytes(0, MAX_SCRIPT_BYTES), amount: sats }), MAX_PREVOUTS),
});

const adaptorPublicKey = opt(union(bytes(0), bytes(33)));

const frostSignJob: Validator<FrostSignJob> = obj({
  key: sparkKey,
  target: signingTarget,
  verifyingKey: bytes33,
  commitment: signingCommitment,
  operatorCommitments: arr(operatorCommitment, MAX_OPERATORS),
  adaptorPublicKey,
});

const frostAggregateJob: Validator<FrostAggregateJob> = obj({
  key: sparkKey,
  target: signingTarget,
  verifyingKey: bytes33,
  commitment: signingCommitment,
  signatureShare: bytes32,
  operators: arr(
    obj({
      identifier,
      commitment: signingCommitment,
      signatureShare: bytes32,
      publicKey: bytes33,
    }),
    MAX_OPERATORS,
  ),
  adaptorPublicKey,
});

const staticDepositClaimStatement: Validator<StaticDepositClaimStatement> = obj({
  kind: literal("static-deposit-claim"),
  network,
  txid: bytes32,
  vout: int(0, 0x7fffffff),
  creditAmountSats: sats,
  sspSignature: bytes(1, 1024),
});

const identityStatement: Validator<IdentityStatement> = union(
  obj({ kind: literal("so-challenge"), challenge: bytes(1, 4096) }),
  obj({ kind: literal("ssp-challenge"), protectedChallenge: str(8192) }),
  obj({
    kind: literal("transfer-package"),
    transferId,
    package: bytes(1, MAX_PACKAGE_BYTES),
  }),
  obj({
    kind: literal("claim-package"),
    transferId,
    package: bytes(1, MAX_PACKAGE_BYTES),
  }),
  staticDepositClaimStatement,
  obj({
    kind: literal("static-deposit-refund"),
    network,
    txid: bytes32,
    vout: int(0, 0x7fffffff),
    amount: sats,
    target: signingTarget,
  }),
  obj({
    kind: literal("watchtower-recovery"),
    network,
    leafId,
    target: signingTarget,
  }),
  obj({ kind: literal("spark-invoice"), invoice: bytes(1, 65_536) }),
  obj({ kind: literal("token-transaction"), partialTransaction: bytes(1, MAX_PACKAGE_BYTES) }),
  obj({
    kind: literal("lightning-address"),
    action: literal("register"),
    domain: str(253),
    username: str(64, /^[a-z0-9\-_.+]{1,64}$/u),
    description: str(512),
    timestamp: safeTime,
  }),
  obj({
    kind: literal("lightning-address"),
    action: literal("unregister"),
    domain: str(253),
    username: str(64, /^[a-z0-9\-_.+]{1,64}$/u),
    timestamp: safeTime,
  }),
);

const htlcTimeoutRequest: Validator<HtlcTimeoutSignRequest> = obj({
  transaction: bytes(1, MAX_TX_BYTES),
  inputIndex: int(0, 0x7fffffff),
  prevoutAmountSats: sats,
  paymentHash: bytes32,
  hashLockPublicKey: bytes33,
});

const prepareTransferRequest: Validator<PrepareTransferRequest> = obj({
  transferId,
  leaves: arr(
    obj({ leafId, key: sparkLeafKey, receiverIdentityPublicKey: bytes33 }),
    MAX_LEAVES,
    1,
  ),
});

const preparedTransfer: Validator<PreparedTransfer> = obj({
  operatorPackages: record(identifier, bytes(1, MAX_PACKAGE_BYTES), MAX_OPERATORS),
  leaves: arr(
    obj({
      leafId,
      newPublicKey: bytes33,
      secretCipher: ciphertext,
      signature: bytes64,
    }),
    MAX_LEAVES,
  ),
});

const prepareClaimRequest: Validator<PrepareClaimRequest> = obj({
  transferId,
  leaves: arr(obj({ leafId, secretCipher: ciphertext }), MAX_LEAVES, 1),
});

const preparedClaim: Validator<PreparedClaim> = obj({
  operatorPackages: record(identifier, bytes(1, MAX_PACKAGE_BYTES), MAX_OPERATORS),
});

const preparedLightningReceive: Validator<PreparedLightningReceive> = obj({
  paymentHash: bytes32,
  operatorPackages: record(identifier, bytes(1, MAX_PACKAGE_BYTES), MAX_OPERATORS),
});

const staticDepositClaimRequest: Validator<StaticDepositClaimRequest> = obj({
  index: int(0, 0x7fffffff),
  statement: staticDepositClaimStatement,
});

const staticDepositClaimResult: Validator<StaticDepositClaimResult> = obj({
  encryptedSecretKey: bytes(1, MAX_CIPHERTEXT_BYTES),
  signature: bytes(64, 128),
});

/**
 * The intent a `spark.approve` registers — kernel-decoded before the host ever displays it. `token`
 * receivers' amounts are canonical decimal strings in the u128 range.
 */
export type SparkApproveIntent =
  | {
      readonly kind: "transfer";
      readonly receivers: ReadonlyArray<{
        readonly identityPublicKey: Uint8Array;
        readonly amountSats: number;
      }>;
    }
  | {
      readonly kind: "lightning";
      readonly invoice: string;
      readonly amountSats?: number;
      readonly maxFeeSats: number;
    }
  | {
      readonly kind: "exit";
      readonly address: string;
      readonly amountSats: number;
      readonly maxFeeSats: number;
    }
  | {
      readonly kind: "onchain";
      readonly address: string;
      readonly maxFeeSats: number;
    }
  | {
      readonly kind: "token";
      readonly tokenIdentifier: Uint8Array;
      readonly receivers: ReadonlyArray<{
        readonly ownerPublicKey: Uint8Array;
        readonly amount: string;
      }>;
    };

/**
 * What `spark.approve` returns: the kernel's own decode of the intent — receivers and amounts, the
 * invoice's payment hash and amount, or the exit/onchain destination — never host-provided text.
 */
export type SparkApprovalSummary =
  | {
      readonly kind: "transfer";
      readonly receivers: ReadonlyArray<{
        readonly identityPublicKey: Uint8Array;
        readonly amountSats: number;
      }>;
    }
  | {
      readonly kind: "lightning";
      readonly paymentHash: Uint8Array;
      readonly invoiceAmountSats?: number;
      readonly maxFeeSats: number;
    }
  | {
      readonly kind: "exit";
      readonly address: string;
      readonly amountSats: number;
      readonly maxFeeSats: number;
    }
  | {
      readonly kind: "onchain";
      readonly address: string;
      readonly maxFeeSats: number;
    }
  | {
      readonly kind: "token";
      readonly tokenIdentifier: Uint8Array;
      readonly receivers: ReadonlyArray<{
        readonly ownerPublicKey: Uint8Array;
        readonly amount: string;
      }>;
    };

// sats amounts are bounded by the protocol's safe-integer contract; u128 token amounts
// travel as canonical decimal strings.
const satsAmount = (): Validator<number> => int(0, Number.MAX_SAFE_INTEGER);
const U128_MAX = 340282366920938463463374607431768211455n;
// Canonical decimal u128: "0" or no leading zeros, at most 2^128 − 1.
const decimalU128: Validator<string> = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 39 ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > U128_MAX
  ) {
    throw new ValidationError();
  }
  return value;
};
const approveIntent: Validator<SparkApproveIntent> = union(
  obj({
    kind: literal("transfer"),
    receivers: arr(obj({ identityPublicKey: bytes(33), amountSats: satsAmount() }), 256, 1),
  }),
  obj({
    kind: literal("lightning"),
    invoice: str(4096),
    amountSats: opt(satsAmount()),
    maxFeeSats: satsAmount(),
  }),
  obj({
    kind: literal("exit"),
    address: str(128),
    amountSats: satsAmount(),
    maxFeeSats: satsAmount(),
  }),
  obj({
    kind: literal("onchain"),
    address: str(128),
    maxFeeSats: satsAmount(),
  }),
  obj({
    kind: literal("token"),
    tokenIdentifier: bytes(32),
    receivers: arr(obj({ ownerPublicKey: bytes(33), amount: decimalU128 }), 256, 1),
  }),
);

const approvalSummary: Validator<SparkApprovalSummary> = union(
  obj({
    kind: literal("transfer"),
    receivers: arr(obj({ identityPublicKey: bytes(33), amountSats: satsAmount() }), 256, 1),
  }),
  obj({
    kind: literal("lightning"),
    paymentHash: bytes(32),
    invoiceAmountSats: opt(satsAmount()),
    maxFeeSats: satsAmount(),
  }),
  obj({
    kind: literal("exit"),
    address: str(128),
    amountSats: satsAmount(),
    maxFeeSats: satsAmount(),
  }),
  obj({
    kind: literal("onchain"),
    address: str(128),
    maxFeeSats: satsAmount(),
  }),
  obj({
    kind: literal("token"),
    tokenIdentifier: bytes(32),
    receivers: arr(obj({ ownerPublicKey: bytes(33), amount: decimalU128 }), 256, 1),
  }),
);

export const SPARK_METHODS: {
  readonly "spark.identityPublicKey": MethodSpec<{ readonly account: SparkAccountRef }, Uint8Array>;
  readonly "spark.publicKeys": MethodSpec<
    { readonly account: SparkAccountRef; readonly keys: ReadonlyArray<SparkLeafKey> },
    ReadonlyArray<Uint8Array>
  >;
  readonly "spark.receivedPublicKeys": MethodSpec<
    { readonly account: SparkAccountRef; readonly ciphertexts: ReadonlyArray<Uint8Array> },
    ReadonlyArray<Uint8Array>
  >;
  readonly "spark.newCommitments": MethodSpec<
    { readonly account: SparkAccountRef; readonly count: number },
    ReadonlyArray<SigningCommitment>
  >;
  readonly "spark.signFrost": MethodSpec<
    { readonly account: SparkAccountRef; readonly jobs: ReadonlyArray<FrostSignJob> },
    ReadonlyArray<Uint8Array>
  >;
  readonly "spark.aggregateFrost": MethodSpec<
    { readonly account: SparkAccountRef; readonly jobs: ReadonlyArray<FrostAggregateJob> },
    ReadonlyArray<Uint8Array>
  >;
  readonly "spark.signIdentity": MethodSpec<
    { readonly account: SparkAccountRef; readonly statement: IdentityStatement },
    Uint8Array
  >;
  readonly "spark.signKeySpend": MethodSpec<
    {
      readonly account: SparkAccountRef;
      readonly key: SparkKey;
      readonly target: SigningTarget;
    },
    Uint8Array
  >;
  readonly "spark.signHtlcTimeout": MethodSpec<
    { readonly account: SparkAccountRef; readonly request: HtlcTimeoutSignRequest },
    Uint8Array
  >;
  readonly "spark.prepareTransfer": MethodSpec<
    { readonly account: SparkAccountRef; readonly request: PrepareTransferRequest },
    PreparedTransfer
  >;
  readonly "spark.prepareClaim": MethodSpec<
    { readonly account: SparkAccountRef; readonly request: PrepareClaimRequest },
    PreparedClaim
  >;
  readonly "spark.prepareLightningReceive": MethodSpec<
    { readonly account: SparkAccountRef },
    PreparedLightningReceive
  >;
  readonly "spark.claimStaticDeposit": MethodSpec<
    { readonly account: SparkAccountRef; readonly request: StaticDepositClaimRequest },
    StaticDepositClaimResult
  >;
  readonly "spark.approve": MethodSpec<
    {
      readonly account: SparkAccountRef;
      readonly intent: SparkApproveIntent;
      readonly verify: Factor;
    },
    SparkApprovalSummary
  >;
} = {
  "spark.identityPublicKey": {
    session: true,
    presence: false,
    params: obj({ account }),
    result: bytes33,
  },
  "spark.publicKeys": {
    session: true,
    presence: false,
    params: obj({ account, keys: arr(sparkLeafKey, MAX_BATCH) }),
    result: arr(bytes33, MAX_BATCH),
  },
  "spark.receivedPublicKeys": {
    session: true,
    presence: false,
    params: obj({ account, ciphertexts: arr(ciphertext, MAX_BATCH) }),
    result: arr(bytes33, MAX_BATCH),
  },
  "spark.newCommitments": {
    session: true,
    presence: false,
    params: obj({ account, count: int(1, MAX_BATCH) }),
    result: arr(signingCommitment, MAX_BATCH),
  },
  "spark.signFrost": {
    session: true,
    presence: false,
    params: obj({ account, jobs: arr(frostSignJob, MAX_BATCH) }),
    result: arr(bytes32, MAX_BATCH),
  },
  "spark.aggregateFrost": {
    session: true,
    presence: false,
    params: obj({ account, jobs: arr(frostAggregateJob, MAX_BATCH) }),
    result: arr(bytes64, MAX_BATCH),
  },
  "spark.signIdentity": {
    session: true,
    presence: false,
    params: obj({ account, statement: identityStatement }),
    result: bytes(64, 128),
  },
  "spark.signKeySpend": {
    session: true,
    presence: false,
    params: obj({ account, key: sparkKey, target: signingTarget }),
    result: bytes64,
  },
  "spark.signHtlcTimeout": {
    session: true,
    presence: false,
    params: obj({ account, request: htlcTimeoutRequest }),
    result: bytes64,
  },
  "spark.prepareTransfer": {
    session: true,
    presence: false,
    params: obj({ account, request: prepareTransferRequest }),
    result: preparedTransfer,
  },
  "spark.prepareClaim": {
    session: true,
    presence: false,
    params: obj({ account, request: prepareClaimRequest }),
    result: preparedClaim,
  },
  "spark.prepareLightningReceive": {
    session: true,
    presence: false,
    params: obj({ account }),
    result: preparedLightningReceive,
  },
  "spark.claimStaticDeposit": {
    session: true,
    presence: false,
    params: obj({ account, request: staticDepositClaimRequest }),
    result: staticDepositClaimResult,
  },
  "spark.approve": {
    session: true,
    presence: true,
    params: obj({ account, intent: approveIntent, verify: factor }),
    result: approvalSummary,
  },
};
