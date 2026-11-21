/**
 * TRON send route: builds the transaction locally from phase-1 primitives against the latest
 * solidified block, cross-checks every decisive read against the independent endpoint, verifies the
 * kernel's signature before anything is broadcast, and tracks the transaction until the solidified
 * node proves it included or expired.
 */
import { ChainError } from "@qntx/wallet-chains";
import {
  buildTronRawData,
  decodeTron,
  encodeTronTransaction,
  isTronAddress,
  lookupTronToken,
  trc20TransferContract,
  tronAddressFromHex,
  tronAddressToEvm,
  tronAddressToHex,
  tronTokenTable,
  tronTransactionId,
  verifyTronTransactionSignature,
} from "@qntx/wallet-chains/tron";
import type { TronContract } from "@qntx/wallet-chains/tron";
import { chains } from "@qntx/wallet/chains";

import {
  account,
  blockId,
  broadcastHex,
  chainParams,
  constantCall,
  headNumber,
  resources,
  solidHead,
  transactionInfo,
  transactionKnown,
  tronBroadcastVerdict,
  tronFeeLimit,
  tronFeeQuote,
} from "../chains/tron.ts";
import type { TronApi, TronChainParams } from "../chains/tron.ts";
import type { TronAccount } from "../gateway/contract/index.ts";
import { collectChecks, feesDiffer } from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import type { RiskFinding } from "../requests/risk.ts";
import type { AssetChange, SimulationOutcome } from "../requests/simulation.ts";
import { submitSigned } from "./broadcast.ts";
import { includedPoll, newId, accountAddressOf, failTx } from "./route.ts";
import type {
  PrepareParams,
  PreparedRequest,
  RouteContext,
  SendParams,
  SignParams,
  TrackedTransaction,
  TxPoll,
} from "./route.ts";

/** `expiration` is this far ahead of the build timestamp — both are the node's millisecond clock. */
const TRON_TTL_MS = 60_000;
/** A prepared transaction whose expiry is nearer than this can no longer be signed safely. */
const TRON_STALE_MS = 5000;
/** Keccak256("Transfer(address,address,uint256)") — the TRC-20 Transfer event topic. */
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** `balanceOf(address)` selector; the address argument is ABI-padded to 32 bytes. */
const BALANCE_OF = "70a08231";

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

/** A node's hex topic tail — the last 21 bytes of a 32-byte topic is a `41…` TRON address. */
const topicAddress = (topic: string | undefined): string | undefined => {
  if (typeof topic !== "string" || !/^[0-9a-fA-F]{64}$/.test(topic)) {
    return undefined;
  }
  return tronAddressFromHex(`41${topic.slice(-40)}`);
};

const sameAccount = (a: TronAccount | undefined, b: TronAccount | undefined): boolean =>
  (a === undefined) === (b === undefined);

const paramsEqual = (a: TronChainParams, b: TronChainParams): boolean =>
  a.transactionFee === b.transactionFee &&
  a.energyFee === b.energyFee &&
  a.createAccountFee === b.createAccountFee &&
  a.createNewAccountFeeInSystemContract === b.createNewAccountFeeInSystemContract &&
  a.memoFee === b.memoFee &&
  a.maxFeeLimit === b.maxFeeLimit &&
  a.createNewAccountBandwidthRate === b.createNewAccountBandwidthRate &&
  a.maxCreateAccountTxSize === b.maxCreateAccountTxSize;

type TokenKind =
  | { readonly kind: "trx" }
  | { readonly kind: "trc10"; readonly assetId: string }
  | { readonly kind: "trc20"; readonly token: string };

const classify = (token: string | undefined): TokenKind => {
  if (token === undefined) {
    return { kind: "trx" };
  }
  if (isTronAddress(token)) {
    return { kind: "trc20", token };
  }
  if (/^[1-9][0-9]{0,6}$/.test(token)) {
    return { kind: "trc10", assetId: token };
  }
  throw new ChainError("invalid-request", `${token} is neither a TRC-10 id nor a TRC-20 address`);
};

/** The account's TRC-10 balance for `assetId` in base units. */
const trc10Balance = (row: TronAccount | undefined, assetId: string): bigint =>
  BigInt(row?.assetV2?.find((e) => e.key === assetId)?.value ?? 0);

/** `balanceOf(address)` on `token`, as a bigint. */
const tokenBalance = async (api: TronApi, token: string, holder: string): Promise<bigint> => {
  const call = await constantCall(api, {
    owner: holder,
    contract: token,
    data: hexToBytes(`${BALANCE_OF}${tronAddressToEvm(holder).slice(2).padStart(64, "0")}`),
  });
  if (!call.ok) {
    throw new ChainError(
      "invalid-request",
      `the token's balanceOf reverted${call.message === undefined ? "" : `: ${call.message}`}`,
    );
  }
  const raw = bytesToHex(call.result).padStart(64, "0").slice(-64);
  return BigInt(`0x${raw}`);
};

/** TRC-20 Transfer logs in a constant call, restricted to the token contract. */
const transferChanges = (
  logs: ReadonlyArray<{
    address?: string | undefined;
    topics?: string[] | undefined;
    data?: string | undefined;
  }>,
  token: string,
  from: string,
  verified: boolean,
): SimulationOutcome => {
  const tokenHex = tronAddressToHex(token).toLowerCase();
  const changes: AssetChange[] = [];
  for (const log of logs) {
    const [topic0] = log.topics ?? [];
    if (topic0 !== TRANSFER_TOPIC || log.address?.toLowerCase() !== tokenHex) {
      continue;
    }
    const logFrom = topicAddress(log.topics?.[1]);
    const logTo = topicAddress(log.topics?.[2]);
    const data = log.data ?? "";
    const amount = /^[0-9a-fA-F]{64}$/.test(data) ? BigInt(`0x${data}`) : 0n;
    const entry = (who: string, sign: bigint): void => {
      if (who === from && amount !== 0n) {
        changes.push({
          asset: token,
          amount: (sign * amount).toString(10),
          ...(verified ? { verified: true } : { verified: false }),
        });
      }
    };
    if (logFrom !== undefined && logTo !== undefined) {
      entry(logFrom, -1n);
      entry(logTo, 1n);
    }
  }
  return { status: "success", changes };
};

/** A failed receipt's display message: the receipt result plus the fee burned, in TRX. */
const failureMessage = (info: {
  failed: boolean;
  receiptResult?: string | undefined;
  resMessage?: string | undefined;
  fee: number;
}): string => {
  const burned = `${(info.fee / 1_000_000).toFixed(6)} TRX`;
  const reason = info.receiptResult ?? info.resMessage ?? "FAILED";
  return `${reason} — burned ${burned}`;
};

export const prepareTron = async (
  ctx: RouteContext,
  params: PrepareParams,
): Promise<PreparedRequest> => {
  const { account: ref, network, to, amount } = params;
  const token = classify(params.token);
  const api = ctx.options.networks.tronApi(network);
  const independent = ctx.options.networks.independentTronApi(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const from = await accountAddressOf(ctx, ref, "tron.bip44", network);
  if (!isTronAddress(to)) {
    throw new ChainError("invalid-request", `${to} is not a TRON address`);
  }
  if (amount <= 0n) {
    throw new ChainError("invalid-request", "amount must be positive");
  }
  /* Self-transfers are refused by the chain for the system contracts (TransferActuator /
     TransferAssetActuator); a TRC-20 transfer to self is a contract call and stays legal. */
  if (token.kind !== "trc20" && to === from) {
    throw new ChainError("invalid-request", "cannot send to the sender");
  }
  const flags: Array<RequestCheckCode | undefined> = [
    independent.kind === "unavailable" ? "reads-unverified" : undefined,
  ];
  const risk: RiskFinding[] = [];

  const head = await solidHead(api);
  const params0 = await chainParams(api);
  const fromRow = await account(api, from);
  if (fromRow === undefined) {
    throw new ChainError("invalid-request", "the sender account is not activated");
  }
  const res = await resources(api, from);
  const toRow = await account(api, to);
  let activates = token.kind !== "trc20" && toRow === undefined;
  if (token.kind !== "trc20" && toRow !== undefined && toRow.type === "Contract") {
    risk.push({ code: "contract-recipient", level: "warning" });
  }

  let contract: TronContract;
  let feeLimit: bigint | undefined;
  let estimate: { readonly used: number; readonly penalty: number } | undefined;
  let call: Awaited<ReturnType<typeof constantCall>> | undefined;
  /** The recipient's token balance — `undefined` for TRX/TRC-10 sends. */
  let theirs: bigint | undefined;
  if (token.kind === "trc20") {
    const [self, their] = await Promise.all([
      tokenBalance(api, token.token, from),
      toRow === undefined ? Promise.resolve(0n) : tokenBalance(api, token.token, to),
    ]);
    theirs = their;
    if (self < amount) {
      throw new ChainError("invalid-request", "the token balance does not cover the amount");
    }
    if (to === token.token) {
      risk.push({ code: "token-contract-recipient", level: "danger" });
    }
    contract = trc20TransferContract(from, token.token, to, amount);
    const data = contract.type === "TriggerSmartContract" ? contract.data : new Uint8Array();
    call = await constantCall(api, { owner: from, contract: token.token, data });
    if (!call.ok) {
      throw new ChainError(
        "invalid-request",
        `the token's transfer reverted${call.message === undefined ? "" : `: ${call.message}`}`,
      );
    }
    estimate = { used: call.energyUsed, penalty: call.energyPenalty };
  } else if (token.kind === "trc10") {
    if (trc10Balance(fromRow, token.assetId) < amount) {
      throw new ChainError("invalid-request", `the account does not hold ${token.assetId}`);
    }
    contract = {
      type: "TransferAssetContract",
      owner: from,
      to,
      assetId: token.assetId,
      amount,
    };
  } else {
    contract = { type: "TransferContract", owner: from, to, amount };
  }

  if (independent.kind === "available") {
    const independentApi = independent.client;
    try {
      const [otherId, otherParams, otherRow] = await Promise.all([
        blockId(independentApi, head.number, false),
        chainParams(independentApi),
        account(independentApi, to),
      ]);
      if (otherId !== head.id) {
        throw new ChainError("invalid-request", "the endpoints disagree on the reference block");
      }
      if (!paramsEqual(params0, otherParams)) {
        throw new ChainError("invalid-request", "the endpoints disagree on chain parameters");
      }
      /* The more conservative answer wins: either endpoint saying "absent" means the send may
         activate the recipient and pays activation. */
      activates = activates || (token.kind !== "trc20" && otherRow === undefined);
      if (!sameAccount(toRow, otherRow) && token.kind === "trc20") {
        flags.push("reads-unverified");
      }
      if (estimate !== undefined) {
        const otherCall = await constantCall(independentApi, {
          owner: from,
          contract: token.kind === "trc20" ? token.token : "",
          data: contract.type === "TriggerSmartContract" ? contract.data : new Uint8Array(),
        });
        if (otherCall.ok) {
          if (feesDiffer(BigInt(otherCall.energyUsed), BigInt(estimate.used))) {
            flags.push("fee-mismatch");
          }
          estimate = {
            used: Math.max(estimate.used, otherCall.energyUsed),
            penalty: Math.max(estimate.penalty, otherCall.energyPenalty),
          };
        } else {
          flags.push("reads-unverified");
        }
      }
    } catch (error) {
      if (error instanceof ChainError) {
        throw error;
      }
      flags.push("reads-unverified");
    }
  }

  if (estimate !== undefined) {
    feeLimit = tronFeeLimit(estimate.used, params0.energyFee, params0.maxFeeLimit);
  }
  const now = ctx.options.now();
  const header = {
    refBlock: { number: head.number, id: head.id },
    timestamp: now,
    expiration: now + TRON_TTL_MS,
    ...(feeLimit === undefined ? {} : { feeLimit }),
  };
  const rawData = buildTronRawData(header, contract);
  const quote = tronFeeQuote({
    rawDataLength: rawData.length,
    params: params0,
    resources: res,
    ...(activates ? { activates: true } : {}),
    ...(estimate === undefined ? {} : { energy: estimate }),
    ...(theirs === 0n ? { tokenRecipientEmpty: true } : {}),
  });
  const outflow = token.kind === "trx" ? amount : 0n;
  const balance = BigInt(fromRow.balance ?? 0);
  if (balance < outflow + BigInt(quote.expected)) {
    throw new ChainError(
      "invalid-request",
      `balance ${balance.toString(10)} does not cover the send plus ${quote.expected} sun of fees`,
    );
  }
  if (token.kind === "trx" && BigInt(quote.max) >= amount) {
    flags.push("fee-exceeds-amount");
  }
  if (quote.warnings.includes("token-recipient-empty")) {
    risk.push({ code: "token-recipient-empty", level: "warning" });
  }

  const request: Extract<SignParams["request"], { kind: "tron.transaction" }> = {
    kind: "tron.transaction",
    network,
    account: ref,
    rawData,
  };
  const intent = decodeTron(request, from);
  const [flow] = intent.outflows;
  const wantAsset =
    token.kind === "trx" ? "sun" : token.kind === "trc10" ? `trc10:${token.assetId}` : token.token;
  if (
    intent.summary !== "transfer" ||
    intent.outflows.length !== 1 ||
    flow === undefined ||
    flow.to !== to ||
    flow.amount.amount !== amount.toString(10) ||
    flow.amount.asset !== wantAsset
  ) {
    throw new ChainError(
      "invalid-request",
      "the built transaction does not decode to the requested transfer",
    );
  }
  const id = newId(ctx.options.random);
  const verified =
    token.kind === "trc20" &&
    lookupTronToken(tronTokenTable, network, token.kind === "trc20" ? token.token : "") !==
      undefined;
  const simulation =
    call !== undefined && call.ok
      ? transferChanges(call.logs, token.kind === "trc20" ? token.token : "", from, verified)
      : undefined;
  const resimulate =
    token.kind === "trc20"
      ? async (): Promise<SimulationOutcome> => {
          const again = await constantCall(api, {
            owner: from,
            contract: token.kind === "trc20" ? token.token : "",
            data: contract.type === "TriggerSmartContract" ? contract.data : new Uint8Array(),
          });
          return again.ok
            ? transferChanges(again.logs, token.kind === "trc20" ? token.token : "", from, verified)
            : {
                status: "reverted",
                error: again.message ?? "the constant call reverted",
              };
        }
      : undefined;

  const submit = async (
    verify: SendParams["verify"],
    commit: () => void,
  ): Promise<TrackedTransaction> => {
    let tx: TrackedTransaction = {
      id,
      family: "tron",
      network,
      account: ref.kind === "hd" ? ref.walletId : ref.keyId,
      hash: undefined,
      state: "draft",
      intent,
      nonce: 0,
      tron: { expiration: header.expiration, from },
      submittedAt: ctx.options.now(),
      error: undefined,
    };
    tx = await ctx.transition(tx, {});
    let signed: Uint8Array;
    try {
      const result = await apis.sign({ request, verify });
      tx = await ctx.transition(tx, { state: "signed" });
      if (result.kind !== "tron.transaction" || !(result.signature instanceof Uint8Array)) {
        throw new Error("unexpected tron sign result");
      }
      if (!verifyTronTransactionSignature(rawData, result.signature, from)) {
        throw new ChainError(
          "invalid-request",
          "the kernel's signature does not verify against the sender",
        );
      }
      signed = result.signature;
      commit();
    } catch (error) {
      await failTx(ctx, tx, error);
      throw error;
    }
    return submitSigned(ctx, tx, {
      id: bytesToHex(tronTransactionId(rawData)),
      raw: bytesToHex(encodeTronTransaction(rawData, [signed])),
      record: { tron: { expiration: header.expiration, from } },
      hold: () => undefined,
      release: () => undefined,
      send: async () => broadcastHex(api, bytesToHex(encodeTronTransaction(rawData, [signed]))),
      verdict: tronBroadcastVerdict,
      known: async () => transactionKnown(api, bytesToHex(tronTransactionId(rawData))),
    });
  };

  return {
    txId: id,
    account: ref,
    network,
    intent,
    checks: collectChecks(flags),
    ...(simulation === undefined ? {} : { simulation }),
    ...(resimulate === undefined ? {} : { resimulate }),
    ...(risk.length === 0 ? {} : { risk }),
    tronFee: quote,
    staleReason: async () => {
      await Promise.resolve();
      return ctx.options.now() >= header.expiration - TRON_STALE_MS
        ? "transaction expired — start over"
        : undefined;
    },
    submit,
    release: () => undefined,
  };
};

/**
 * One poll. Read order is fixed: the solidified head first (it bounds drop proofs and gives the
 * rebroadcast window), then the solidified info, then — for a not-yet-included row — the full-node
 * info; an included row reads the full-node head before its infos so a reorg cannot be proven by a
 * node that has not reached the persisted block yet.
 */
export const pollTron = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
): Promise<TxPoll | undefined> => {
  if (tx.hash === undefined) {
    return { kind: "ended", state: "failed" };
  }
  const api = ctx.options.networks.tronApi(tx.network);
  const expiration = tx.tron?.expiration;
  if (tx.block !== undefined) {
    const head = await headNumber(api);
    const solid = await transactionInfo(api, tx.hash, true);
    if (solid !== undefined) {
      return includedPoll(
        tx,
        solid.failed ? "failed" : "confirmed",
        { height: solid.blockNumber },
        true,
        solid.failed ? failureMessage(solid) : undefined,
      );
    }
    const info = await transactionInfo(api, tx.hash, false);
    if (info !== undefined) {
      return includedPoll(
        tx,
        info.failed ? "failed" : "confirmed",
        { height: info.blockNumber },
        false,
        info.failed ? failureMessage(info) : undefined,
      );
    }
    return head >= tx.block.height ? { kind: "reorged" } : undefined;
  }
  const head = await solidHead(api);
  const solid = await transactionInfo(api, tx.hash, true);
  if (solid !== undefined) {
    return {
      kind: "included",
      state: solid.failed ? "failed" : "confirmed",
      block: { height: solid.blockNumber },
      final: true,
      ...(solid.failed ? { error: failureMessage(solid) } : {}),
    };
  }
  const info = await transactionInfo(api, tx.hash, false);
  if (info !== undefined) {
    return {
      kind: "included",
      state: info.failed ? "failed" : "confirmed",
      block: { height: info.blockNumber },
      final: false,
      ...(info.failed ? { error: failureMessage(info) } : {}),
    };
  }
  /* A transaction neither node knows is dropped only once the solidified head is past its
     expiration — until then it may still land, so the signed bytes are rebroadcast. */
  if (expiration !== undefined && head.timestamp > expiration) {
    return { kind: "ended", state: "dropped" };
  }
  if (tx.raw !== undefined) {
    await broadcastHex(api, tx.raw).catch(() => "");
  }
  return undefined;
};
