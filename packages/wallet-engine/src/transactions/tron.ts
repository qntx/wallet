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
  trc20ApproveContract,
  encodeTronTransaction,
  isTronAddress,
  lookupTronToken,
  trc20TransferContract,
  tronAddressFromHex,
  tronAddressToEvm,
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
  canDelegateMaxSize,
  delegatedResource,
  reward,
  stakeParams,
  transactionKnown,
  tronBroadcastVerdict,
  tronLogAddress,
  unfreezeCount,
  witnesses,
  tronFeeLimit,
  tronFeeQuote,
} from "../chains/tron.ts";
import type { TronApi, TronChainParams, TronHead, TronResources } from "../chains/tron.ts";
import type { TronAccount } from "../gateway/contract/index.ts";
import type { Independent } from "../networks/controller.ts";
import { collectChecks, feesDiffer } from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import type { RiskFinding } from "../requests/risk.ts";
import type { AssetChange, SimulationOutcome } from "../requests/simulation.ts";
import { submitSigned } from "./broadcast.ts";
import { includedPoll, newId, accountAddressOf, failTx } from "./route.ts";
import type {
  AccountRef,
  ChainRequestInput,
  PrepareParams,
  PreparedRequest,
  RouteContext,
  SendParams,
  SignParams,
  TrackedTransaction,
  TxPoll,
} from "./route.ts";

/** `expiration` is this far ahead of the build timestamp — both read the engine's own clock. */
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
  a.maxFeeLimit === b.maxFeeLimit &&
  a.createNewAccountBandwidthRate === b.createNewAccountBandwidthRate &&
  a.maxCreateAccountTxSize === b.maxCreateAccountTxSize;

/**
 * The independent-endpoint cross-check (invariant 2): the reference block id and the fee-model
 * chain parameters must match the primary's answers — a disagreement refuses the prepare; any other
 * read failure degrades to a `reads-unverified` flag. `extra` runs the operation-specific checks
 * (recipient existence, energy estimate) inside the same failure umbrella.
 */
const crossCheckTron = async (
  independent: Independent<TronApi>,
  head: TronHead,
  params: TronChainParams,
  extra?: (api: TronApi) => Promise<void>,
): Promise<"reads-unverified" | undefined> => {
  if (independent.kind !== "available") {
    return undefined;
  }
  try {
    const api = independent.client;
    const [otherId, otherParams] = await Promise.all([
      blockId(api, head.number, false),
      chainParams(api),
    ]);
    if (otherId !== head.id) {
      throw new ChainError("invalid-request", "the endpoints disagree on the reference block");
    }
    if (!paramsEqual(params, otherParams)) {
      throw new ChainError("invalid-request", "the endpoints disagree on chain parameters");
    }
    await extra?.(api);
    return undefined;
  } catch (error) {
    if (error instanceof ChainError) {
      throw error;
    }
    return "reads-unverified";
  }
};

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
  const changes: AssetChange[] = [];
  for (const log of logs) {
    const [topic0] = log.topics ?? [];
    if (topic0 !== TRANSFER_TOPIC || tronLogAddress(log.address) !== token) {
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

  {
    /* The more conservative answer wins: either endpoint saying "absent" means the send may
       activate the recipient and pays activation. */
    const extra = async (independentApi: TronApi): Promise<void> => {
      const otherRow = await account(independentApi, to);
      activates = activates || (token.kind !== "trc20" && otherRow === undefined);
      if (!sameAccount(toRow, otherRow) && token.kind === "trc20") {
        flags.push("reads-unverified");
      }
      if (estimate === undefined) {
        return;
      }
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
    };
    const flag = await crossCheckTron(independent, head, params0, extra);
    if (flag !== undefined) {
      flags.push(flag);
    }
  }

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

  return finishTron(ctx, {
    api,
    ref,
    network,
    from,
    contract,
    head,
    params: params0,
    resources: res,
    balance: BigInt(fromRow.balance ?? 0),
    outflow: token.kind === "trx" ? amount : 0n,
    ...(estimate === undefined ? {} : { estimate }),
    ...(activates ? { activates: true } : {}),
    ...(theirs === 0n ? { tokenRecipientEmpty: true } : {}),
    ...(token.kind === "trx" ? { exceedsAmount: amount } : {}),
    flags,
    risk,
    assertIntent: (intent) => {
      const [flow] = intent.outflows;
      const wantAsset =
        token.kind === "trx"
          ? "sun"
          : token.kind === "trc10"
            ? `trc10:${token.assetId}`
            : token.token;
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
    },
    ...(simulation === undefined ? {} : { simulation }),
    ...(resimulate === undefined ? {} : { resimulate }),
  });
};

type TronFinish = {
  readonly api: TronApi;
  readonly ref: AccountRef;
  readonly network: string;
  readonly from: string;
  readonly contract: TronContract;
  readonly head: TronHead;
  readonly params: TronChainParams;
  readonly resources: TronResources;
  readonly balance: bigint;
  /** Liquid TRX the operation locks or sends — checked against `balance` together with fees. */
  readonly outflow: bigint;
  readonly estimate?: { readonly used: number; readonly penalty: number };
  readonly activates?: boolean;
  readonly tokenRecipientEmpty?: boolean;
  /** TRX amount `quote.max` must not exceed (a plain TRX send); absent skips the check. */
  readonly exceedsAmount?: bigint;
  readonly flags: Array<RequestCheckCode | undefined>;
  readonly risk: RiskFinding[];
  /** Refuses unless the locally built raw data decodes to exactly the requested operation. */
  readonly assertIntent: (intent: ReturnType<typeof decodeTron>) => void;
  readonly simulation?: SimulationOutcome;
  readonly resimulate?: () => Promise<SimulationOutcome>;
};

/**
 * The shared operation tail: fee_limit → header → raw data → quote → balance refusal → decode
 * assertion → intent → sign → verify → broadcast → track. Every TRON operation sends the same
 * single-signature transaction and never touches a node-provided `transaction` field.
 */
const finishTron = (ctx: RouteContext, input: TronFinish): PreparedRequest => {
  const { api, ref, network, from, contract, head, params: params0, resources: res } = input;
  const { flags, risk } = input;
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const { estimate } = input;
  const feeLimit =
    estimate === undefined
      ? undefined
      : tronFeeLimit(estimate.used, params0.energyFee, params0.maxFeeLimit);
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
    ...(input.activates === true ? { activates: true } : {}),
    ...(estimate === undefined ? {} : { energy: estimate }),
    ...(input.tokenRecipientEmpty === true ? { tokenRecipientEmpty: true } : {}),
  });
  if (input.balance < input.outflow + BigInt(quote.expected)) {
    throw new ChainError(
      "invalid-request",
      `balance ${input.balance.toString(10)} does not cover the operation plus ${quote.expected} sun of fees`,
    );
  }
  if (input.exceedsAmount !== undefined && BigInt(quote.max) >= input.exceedsAmount) {
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
  input.assertIntent(intent);
  const id = newId(ctx.options.random);
  const { simulation } = input;
  const { resimulate } = input;

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

const RESOURCE_CODE = { bandwidth: 0, energy: 1 } as const;

/** FrozenV2/unfrozenV2 `type` is an enum name or number; absent is BANDWIDTH (enum 0). */
const frozenResource = (type: string | number | undefined): 0 | 1 =>
  type === "ENERGY" || type === 1 ? 1 : 0;

/** The sun amount staked for `resource` on `row`, or 0 when the account never froze it. */
const frozenFor = (row: TronAccount, resource: 0 | 1): bigint => {
  let total = 0n;
  for (const f of row.frozenV2 ?? []) {
    if (frozenResource(f.type) === resource) {
      total += BigInt(Math.trunc(f.amount ?? 0));
    }
  }
  return total;
};

const ONE_TRX = 1_000_000n;
const DAY_MS = 86_400_000;
/** Java-tron CommonParameter BLOCK_PRODUCED_INTERVAL — one block every 3 s. */
const BLOCK_MS = 3000n;

const tronStakeAction = (intent: ReturnType<typeof decodeTron>) => {
  if (intent.summary !== "stake" || intent.staking === undefined || intent.staking.length !== 1) {
    return undefined;
  }
  return intent.staking[0];
};

const sunAmount = (a: { readonly amount: { readonly asset: string; readonly amount: string } }) =>
  a.amount.asset === "sun" ? BigInt(a.amount.amount) : undefined;

/**
 * An internal `tron-stake` request: the java-tron actuator checks are run against the node's
 * account/resource answers first (file@line cites live in the code), then the operation goes
 * through the shared build → quote → decode-assert → sign → track tail.
 */
export const prepareTronStake = async (
  ctx: RouteContext,
  input: Extract<ChainRequestInput, { method: "tron-stake" }>,
): Promise<PreparedRequest> => {
  const { account: ref, network, action } = input;
  const api = ctx.options.networks.tronApi(network);
  const independent = ctx.options.networks.independentTronApi(network);
  const from = await accountAddressOf(ctx, ref, "tron.bip44", network);
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
  const balance = BigInt(fromRow.balance ?? 0);
  const now = ctx.options.now();

  let contract: TronContract;
  let outflow = 0n;
  let assert: (action0: NonNullable<ReturnType<typeof tronStakeAction>>) => boolean;
  switch (action.kind) {
    case "freeze": {
      const resource = RESOURCE_CODE[action.resource];
      if (action.amount < ONE_TRX) {
        // FreezeBalanceActuatorV2 checks amount >= minFrozenBalance (1 TRX).
        throw new ChainError("invalid-request", "freeze requires at least 1 TRX");
      }
      contract = {
        type: "FreezeBalanceV2Contract",
        owner: from,
        amount: action.amount,
        resource,
      };
      outflow = action.amount;
      assert = (a) =>
        a.kind === "tron-freeze" &&
        a.resource === action.resource &&
        sunAmount(a) === action.amount;
      break;
    }
    case "unfreeze": {
      const resource = RESOURCE_CODE[action.resource];
      if (action.amount <= 0n || action.amount > frozenFor(fromRow, resource)) {
        throw new ChainError(
          "invalid-request",
          `cannot unfreeze ${action.amount.toString(10)} sun of ${action.resource}`,
        );
      }
      if ((await unfreezeCount(api, from)) <= 0) {
        // UnfreezeBalanceV2Actuator refuses when the concurrent-unfreeze slot is exhausted.
        throw new ChainError("invalid-request", "no unfreeze slot is available");
      }
      contract = {
        type: "UnfreezeBalanceV2Contract",
        owner: from,
        amount: action.amount,
        resource,
      };
      assert = (a) =>
        a.kind === "tron-unfreeze" &&
        a.resource === action.resource &&
        sunAmount(a) === action.amount;
      break;
    }
    case "withdraw-expired": {
      const expired = (fromRow.unfrozenV2 ?? []).some(
        (u) => Math.trunc(u.unfreeze_expire_time ?? Number.POSITIVE_INFINITY) <= now,
      );
      if (!expired) {
        // WithdrawExpireUnfreezeActuator requires an unfrozenV2 row past its expire time.
        throw new ChainError("invalid-request", "no expired unfreeze entry to withdraw");
      }
      contract = { type: "WithdrawExpireUnfreezeContract", owner: from };
      assert = (a) => a.kind === "tron-withdraw-unfrozen";
      break;
    }
    case "cancel-unfreeze":
      if ((fromRow.unfrozenV2 ?? []).length === 0) {
        // CancelAllUnfreezeV2Actuator refuses an empty unfreeze queue.
        throw new ChainError("invalid-request", "no unfreeze entries to cancel");
      }
      contract = { type: "CancelAllUnfreezeV2Contract", owner: from };
      assert = (a) => a.kind === "tron-cancel-unfreeze";
      break;

    case "delegate": {
      const resource = RESOURCE_CODE[action.resource];
      if (action.amount < ONE_TRX) {
        // DelegateResourceActuator requires the delegated amount to be at least 1 TRX.
        throw new ChainError("invalid-request", "delegate requires at least 1 TRX");
      }
      if (!isTronAddress(action.receiver)) {
        throw new ChainError("invalid-request", `${action.receiver} is not a TRON address`);
      }
      if (action.receiver === from) {
        throw new ChainError("invalid-request", "cannot delegate to the sender");
      }
      const receiver = await account(api, action.receiver);
      if (receiver === undefined) {
        throw new ChainError("invalid-request", "the delegation receiver does not exist");
      }
      if (receiver.type === "Contract") {
        // DelegateResourceActuator refuses contract receivers.
        throw new ChainError("invalid-request", "cannot delegate to a contract");
      }
      const max = await canDelegateMaxSize(api, from, resource);
      if (action.amount > max) {
        throw new ChainError(
          "invalid-request",
          `delegation exceeds the available ${max.toString(10)} sun`,
        );
      }
      if (action.lockBlocks !== undefined) {
        const stake = await stakeParams(api);
        if (
          action.lockBlocks < 1 ||
          !Number.isInteger(action.lockBlocks) ||
          BigInt(action.lockBlocks) > stake.maxDelegateLockPeriod
        ) {
          throw new ChainError(
            "invalid-request",
            `lock period must be 1..${stake.maxDelegateLockPeriod.toString(10)} blocks`,
          );
        }
        // DelegateResourceActuator.validRemainTime: a still-locked delegation to the same
        // receiver forces the new lock to cover the old lock's remaining time.
        const row = await delegatedResource(api, from, action.receiver, resource, now);
        const remain = BigInt(Math.trunc(row.lockedUntil)) - BigInt(Math.trunc(now));
        if (remain > 0n && BigInt(action.lockBlocks) * BLOCK_MS < remain) {
          throw new ChainError(
            "invalid-request",
            `lock period must cover the ${remain.toString(10)} ms left on the live lock`,
          );
        }
      }
      contract = {
        type: "DelegateResourceContract",
        owner: from,
        resource,
        balance: action.amount,
        receiver: action.receiver,
        lock: action.lockBlocks !== undefined,
        lockPeriod: BigInt(action.lockBlocks ?? 0),
      };
      // Delegation moves staked TRX, not liquid balance — the balance check covers fees only.
      assert = (a) =>
        a.kind === "tron-delegate" &&
        a.receiver === action.receiver &&
        a.resource === action.resource &&
        sunAmount(a) === action.amount &&
        (action.lockBlocks === undefined
          ? a.lock === undefined
          : a.lock?.blocks === action.lockBlocks.toString(10));
      break;
    }
    case "undelegate": {
      const resource = RESOURCE_CODE[action.resource];
      if (action.amount <= 0n) {
        throw new ChainError("invalid-request", "undelegate amount must be positive");
      }
      if (!isTronAddress(action.receiver)) {
        throw new ChainError("invalid-request", `${action.receiver} is not a TRON address`);
      }
      // Still-locked delegations cannot be un-delegated until their lock expires.
      const delegated = await delegatedResource(api, from, action.receiver, resource, now);
      if (action.amount > delegated.unlocked) {
        throw new ChainError(
          "invalid-request",
          `undelegate exceeds the unlocked ${delegated.unlocked.toString(10)} sun`,
        );
      }
      contract = {
        type: "UnDelegateResourceContract",
        owner: from,
        resource,
        balance: action.amount,
        receiver: action.receiver,
      };
      assert = (a) =>
        a.kind === "tron-undelegate" &&
        a.receiver === action.receiver &&
        a.resource === action.resource &&
        sunAmount(a) === action.amount;
      break;
    }
    case "vote": {
      if (action.votes.length === 0 || action.votes.length > 30) {
        // VoteWitnessActuator refuses an empty vote and caps at MAX_VOTE_NUMBER (30).
        throw new ChainError("invalid-request", "vote takes 1..30 witnesses");
      }
      if (action.votes.some((v) => v.count <= 0n)) {
        throw new ChainError("invalid-request", "vote counts must be positive");
      }
      const listed = new Set(await witnesses(api));
      for (const vote of action.votes) {
        if (!listed.has(vote.witness)) {
          // VoteWitnessActuator counts votes for accounts that are not witnesses as invalid.
          throw new ChainError("invalid-request", `${vote.witness} is not a witness`);
        }
      }
      let total = 0n;
      for (const v of action.votes) {
        total += v.count;
      }
      if (total > BigInt(res.tronPowerLimit)) {
        throw new ChainError("invalid-request", "votes exceed the available tron power");
      }
      contract = {
        type: "VoteWitnessContract",
        owner: from,
        votes: action.votes.map((v) => ({ witness: v.witness, count: v.count })),
        support: true,
      };
      assert = (a) =>
        a.kind === "tron-vote" &&
        a.votes.length === action.votes.length &&
        a.votes.every(
          (v, i) =>
            v.witness === action.votes[i]?.witness &&
            v.count === action.votes[i]?.count.toString(10),
        );
      break;
    }
    case "claim-rewards": {
      if ((await reward(api, from)) <= 0n) {
        // WithdrawBalanceActuator refuses when allowance/withdrawable reward is zero.
        throw new ChainError("invalid-request", "there is no reward to claim");
      }
      const stake = await stakeParams(api);
      const last = Math.trunc(fromRow.latest_withdraw_time ?? 0);
      const wait = Number(stake.witnessAllowanceFrozenTime) * DAY_MS;
      if (now - last < wait) {
        // WithdrawBalanceActuator enforces witnessAllowanceFrozenTime days between claims.
        throw new ChainError("invalid-request", "the claim period has not passed yet");
      }
      contract = { type: "WithdrawBalanceContract", owner: from };
      assert = (a) => a.kind === "tron-claim-rewards";
      break;
    }
  }

  const flag = await crossCheckTron(independent, head, params0);
  if (flag !== undefined) {
    flags.push(flag);
  }

  return finishTron(ctx, {
    api,
    ref,
    network,
    from,
    contract,
    head,
    params: params0,
    resources: res,
    balance,
    outflow,
    flags,
    risk,
    assertIntent: (intent) => {
      const staking = tronStakeAction(intent);
      if (staking === undefined || !assert(staking)) {
        throw new ChainError(
          "invalid-request",
          "the built transaction does not decode to the requested stake operation",
        );
      }
    },
  });
};

/**
 * An internal `tron-approve` request: builds the TRC-20 `approve` calldata locally, estimates its
 * energy by replaying the exact call, and lets `chainRisk` flag an unlimited allowance. `amount` of
 * 0 revokes.
 */
export const prepareTronApprove = async (
  ctx: RouteContext,
  input: Extract<ChainRequestInput, { method: "tron-approve" }>,
): Promise<PreparedRequest> => {
  const { account: ref, network, token, spender, amount } = input;
  const api = ctx.options.networks.tronApi(network);
  const independent = ctx.options.networks.independentTronApi(network);
  const from = await accountAddressOf(ctx, ref, "tron.bip44", network);
  if (!isTronAddress(token)) {
    throw new ChainError("invalid-request", `${token} is not a TRON address`);
  }
  if (!isTronAddress(spender)) {
    throw new ChainError("invalid-request", `${spender} is not a TRON address`);
  }
  if (amount < 0n) {
    throw new ChainError("invalid-request", "amount must not be negative");
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

  const contract = trc20ApproveContract(from, token, spender, amount);
  const data = contract.type === "TriggerSmartContract" ? contract.data : new Uint8Array();
  const call = await constantCall(api, { owner: from, contract: token, data });
  if (!call.ok) {
    throw new ChainError(
      "invalid-request",
      `the token's approve reverted${call.message === undefined ? "" : `: ${call.message}`}`,
    );
  }
  let estimate = { used: call.energyUsed, penalty: call.energyPenalty };

  const flag = await crossCheckTron(independent, head, params0, async (independentApi) => {
    const other = await constantCall(independentApi, { owner: from, contract: token, data });
    if (other.ok) {
      if (feesDiffer(BigInt(other.energyUsed), BigInt(estimate.used))) {
        flags.push("fee-mismatch");
      }
      estimate = {
        used: Math.max(estimate.used, other.energyUsed),
        penalty: Math.max(estimate.penalty, other.energyPenalty),
      };
    } else {
      flags.push("reads-unverified");
    }
  });
  if (flag !== undefined) {
    flags.push(flag);
  }

  return finishTron(ctx, {
    api,
    ref,
    network,
    from,
    contract,
    head,
    params: params0,
    resources: res,
    balance: BigInt(fromRow.balance ?? 0),
    outflow: 0n,
    estimate,
    flags,
    risk,
    assertIntent: (intent) => {
      const ok =
        intent.approvals.length === 1 &&
        intent.approvals.every(
          (a) =>
            a.kind === "allowance" &&
            a.spender === spender &&
            a.amount.asset === token &&
            a.amount.amount === amount.toString(10),
        );
      if (!ok) {
        throw new ChainError(
          "invalid-request",
          "the built transaction does not decode to the requested approval",
        );
      }
    },
  });
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
