/**
 * Input projection for the proxy signer: every request value is rebuilt from its declared wire
 * fields only — callers (e.g. SparkClient) hand us library objects that may carry extra keys
 * (protobuf-es `$typeName`, branding), and the kernel's strict obj() validators reject any key not
 * in the shape. Unknown `kind`/`type` discriminants fail `invalid-input` here, before any request
 * is posted.
 */
import type {
  FrostAggregateJob,
  FrostSignJob,
  HtlcTimeoutSignRequest,
  IdentityStatement,
  OperatorCommitment,
  PrepareClaimRequest,
  PrepareTransferRequest,
  SigningCommitment,
  SigningTarget,
  SparkKey,
  SparkLeafKey,
  StaticDepositClaimRequest,
  StaticDepositClaimStatement,
} from "../protocol/index.ts";
import { WalletError } from "../types.ts";

function bad(what: string): never {
  throw new WalletError("invalid-input", `spark: unexpected ${what}`);
}

const u8 = (v: Uint8Array, what: string): Uint8Array => (v instanceof Uint8Array ? v : bad(what));
const s = (v: string, what: string): string => (typeof v === "string" ? v : bad(what));
const n = (v: number, what: string): number => (typeof v === "number" ? v : bad(what));

export function leafKey(key: SparkLeafKey): SparkLeafKey {
  if (key.type === "leaf") {
    return { type: "leaf", leafId: s(key.leafId, "leafId") };
  }
  if (key.type === "static-deposit") {
    return { type: "static-deposit", index: n(key.index, "index") };
  }
  return bad("leaf key type");
}

export function sparkKey(key: SparkKey): SparkKey {
  if (key.type === "received") {
    return { type: "received", ciphertext: u8(key.ciphertext, "ciphertext") };
  }
  return leafKey(key);
}

export function commitment(c: SigningCommitment): SigningCommitment {
  return {
    hiding: u8(c.hiding, "commitment.hiding"),
    binding: u8(c.binding, "commitment.binding"),
  };
}

function operatorCommitment(c: OperatorCommitment): OperatorCommitment {
  return { identifier: s(c.identifier, "identifier"), commitment: commitment(c.commitment) };
}

export function signingTarget(target: SigningTarget): SigningTarget {
  return {
    transaction: u8(target.transaction, "target.transaction"),
    inputIndex: n(target.inputIndex, "target.inputIndex"),
    prevouts: target.prevouts.map((p) => ({
      script: u8(p.script, "prevout.script"),
      amount: n(p.amount, "prevout.amount"),
    })),
  };
}

export function frostSignJob(job: FrostSignJob): FrostSignJob {
  return {
    key: sparkKey(job.key),
    target: signingTarget(job.target),
    verifyingKey: u8(job.verifyingKey, "verifyingKey"),
    commitment: commitment(job.commitment),
    operatorCommitments: job.operatorCommitments.map(operatorCommitment),
    ...(job.adaptorPublicKey === undefined
      ? {}
      : { adaptorPublicKey: u8(job.adaptorPublicKey, "adaptorPublicKey") }),
    ...(job.exit === undefined
      ? {}
      : {
          exit: {
            connectorTx: u8(job.exit.connectorTx, "exit.connectorTx"),
            exitTx: u8(job.exit.exitTx, "exit.exitTx"),
          },
        }),
  };
}

export function frostAggregateJob(job: FrostAggregateJob): FrostAggregateJob {
  return {
    key: sparkKey(job.key),
    target: signingTarget(job.target),
    verifyingKey: u8(job.verifyingKey, "verifyingKey"),
    commitment: commitment(job.commitment),
    signatureShare: u8(job.signatureShare, "signatureShare"),
    operators: job.operators.map((op) => ({
      identifier: s(op.identifier, "identifier"),
      commitment: commitment(op.commitment),
      signatureShare: u8(op.signatureShare, "operator.signatureShare"),
      publicKey: u8(op.publicKey, "operator.publicKey"),
    })),
    ...(job.adaptorPublicKey === undefined
      ? {}
      : { adaptorPublicKey: u8(job.adaptorPublicKey, "adaptorPublicKey") }),
  };
}

function depositClaimStatement(
  st: Extract<IdentityStatement, { kind: "static-deposit-claim" }>,
): StaticDepositClaimStatement {
  return {
    kind: "static-deposit-claim",
    network: st.network,
    txid: u8(st.txid, "txid"),
    vout: n(st.vout, "vout"),
    creditAmountSats: n(st.creditAmountSats, "creditAmountSats"),
    sspSignature: u8(st.sspSignature, "sspSignature"),
  };
}

export function identityStatement(statement: IdentityStatement): IdentityStatement {
  const { kind } = statement;
  if (kind === "so-challenge") {
    return { kind: "so-challenge", challenge: u8(statement.challenge, "challenge") };
  }
  if (kind === "ssp-challenge") {
    return {
      kind: "ssp-challenge",
      protectedChallenge: s(statement.protectedChallenge, "protectedChallenge"),
    };
  }
  if (kind === "transfer-package" || kind === "claim-package") {
    return {
      kind,
      transferId: s(statement.transferId, "transferId"),
      package: u8(statement.package, "package"),
    };
  }
  if (kind === "static-deposit-claim") {
    return depositClaimStatement(statement);
  }
  if (kind === "static-deposit-refund") {
    return {
      kind: "static-deposit-refund",
      network: statement.network,
      txid: u8(statement.txid, "txid"),
      vout: n(statement.vout, "vout"),
      amount: n(statement.amount, "amount"),
      target: signingTarget(statement.target),
    };
  }
  if (kind === "watchtower-recovery") {
    return {
      kind: "watchtower-recovery",
      network: statement.network,
      leafId: s(statement.leafId, "leafId"),
      target: signingTarget(statement.target),
    };
  }
  if (kind === "spark-invoice") {
    return { kind: "spark-invoice", invoice: u8(statement.invoice, "invoice") };
  }
  if (kind === "token-transaction") {
    return {
      kind: "token-transaction",
      partialTransaction: u8(statement.partialTransaction, "partialTransaction"),
    };
  }
  if (kind === "lightning-address") {
    return statement.action === "register"
      ? {
          kind: "lightning-address",
          action: "register",
          domain: s(statement.domain, "domain"),
          username: s(statement.username, "username"),
          description: s(statement.description, "description"),
          timestamp: n(statement.timestamp, "timestamp"),
        }
      : {
          kind: "lightning-address",
          action: "unregister",
          domain: s(statement.domain, "domain"),
          username: s(statement.username, "username"),
          timestamp: n(statement.timestamp, "timestamp"),
        };
  }
  return bad("statement kind");
}
export function prepareTransferRequest(req: PrepareTransferRequest): PrepareTransferRequest {
  return {
    transferId: s(req.transferId, "transferId"),
    leaves: req.leaves.map((leaf) => ({
      leafId: s(leaf.leafId, "leafId"),
      key: leafKey(leaf.key),
      receiverIdentityPublicKey: u8(leaf.receiverIdentityPublicKey, "receiverIdentityPublicKey"),
    })),
  };
}

export function prepareClaimRequest(req: PrepareClaimRequest): PrepareClaimRequest {
  return {
    transferId: s(req.transferId, "transferId"),
    leaves: req.leaves.map((leaf) => ({
      leafId: s(leaf.leafId, "leafId"),
      secretCipher: u8(leaf.secretCipher, "secretCipher"),
    })),
  };
}

export function htlcTimeoutRequest(req: HtlcTimeoutSignRequest): HtlcTimeoutSignRequest {
  return {
    transaction: u8(req.transaction, "transaction"),
    inputIndex: n(req.inputIndex, "inputIndex"),
    prevoutAmountSats: n(req.prevoutAmountSats, "prevoutAmountSats"),
    paymentHash: u8(req.paymentHash, "paymentHash"),
    hashLockPublicKey: u8(req.hashLockPublicKey, "hashLockPublicKey"),
  };
}

export function staticDepositClaimRequest(
  req: StaticDepositClaimRequest,
): StaticDepositClaimRequest {
  return { index: n(req.index, "index"), statement: depositClaimStatement(req.statement) };
}
