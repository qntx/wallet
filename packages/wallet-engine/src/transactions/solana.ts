import { base64 } from "@scure/base";
import { address, createAddressWithSeed } from "@solana/kit";

import type { StakeAction } from "@qntx/wallet-chains";
import { ChainError } from "@qntx/wallet-chains";
import {
  decodeSolana,
  netAfterTransferFee,
  parseMintExtensions,
  PROGRAM_IDS,
} from "@qntx/wallet-chains/solana";
import type { MintExtensionSummary } from "@qntx/wallet-chains/solana";
/** Solana route: SOL/SPL send → sign → broadcast, plus status poll with rebroadcast/drop. */
import { chains } from "@qntx/wallet/chains";

import { STAKE_ACCOUNT_BYTES, SolanaChainAdapter } from "../chains/solana.ts";
import type { SolanaIntent, SolanaUnsignedTransaction } from "../chains/solana.ts";
import type { SolanaRpc, Independent } from "../networks/controller.ts";
import {
  collectChecks,
  exceedsNetworkCap,
  feeReachesAmount,
  mergeSolanaQuote,
} from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import type {
  AccountRef,
  ChainRequestInput,
  DisplayIntent,
  PrepareParams,
  PreparedRequest,
  RouteContext,
  SendParams,
  TrackedTransaction,
  TxState,
} from "./route.ts";
import { newId, failTx, submitTx } from "./route.ts";

/** The network's base signature fee, lamports per signature. */
const BASE_FEE_LAMPORTS = 5000n;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const str = (v: unknown, fallback = "0"): string => {
  if (typeof v === "string") {
    return v;
  }
  return typeof v === "number" || typeof v === "bigint" ? String(v) : fallback;
};

const solana = new SolanaChainAdapter();

/** Signed wire transactions kept for re-broadcast until the tx confirms or drops. */
const wires = new Map<string, Uint8Array>();

export const prepareSolana = async (
  ctx: RouteContext,
  params: PrepareParams,
): Promise<PreparedRequest> => {
  const { account, network, to, amount, fee } = params;
  if (account.kind !== "hd") {
    throw new Error("imported accounts are not yet supported");
  }
  const rpc = ctx.options.networks.solanaRpc(network);
  const independent = ctx.options.networks.independentSolanaRpc(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const solAccount = await apis.account({
    walletId: account.walletId,
    groupIndex: account.groupIndex,
    template: "solana.bip44-change",
    network,
  });
  const from = "address" in solAccount ? solAccount.address : "";
  // For an SPL transfer, resolve the mint's owner (Token vs Token-2022) and reject the
  // extension combinations the wallet cannot carry before any signing or broadcast.
  let tokenProgram: string | undefined;
  let ext: MintExtensionSummary | undefined;
  if (params.token !== undefined) {
    const mintInfo = await rpc.call("getAccountInfo", [
      params.token,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const owner = obj(mintInfo)?.["value"];
    if (obj(owner)?.["owner"] === PROGRAM_IDS.token2022) {
      tokenProgram = PROGRAM_IDS.token2022;
      const mintBytes = arr(obj(owner)?.["data"])?.[0];
      const raw = typeof mintBytes === "string" ? base64.decode(mintBytes) : undefined;
      if (raw !== undefined && raw.length > 166) {
        const epoch = obj(await rpc.call("getEpochInfo", []))?.["epoch"];
        ext = parseMintExtensions(raw, BigInt(typeof epoch === "number" ? epoch : 0));
        if (ext.nonTransferable === true) {
          throw new Error("token is non-transferable");
        }
        if (ext.confidential === true) {
          throw new Error("confidential transfer extensions are not supported");
        }
      }
    }
  }
  const unsigned = await solana.build(
    rpc,
    network,
    from,
    params.token === undefined
      ? { kind: "sol", to, lamports: amount }
      : {
          kind: "spl",
          mint: params.token,
          to,
          amount,
          decimals: params.decimals ?? 0,
          ...(tokenProgram === undefined ? {} : { tokenProgram }),
        },
  );
  return finishPrepared(ctx, {
    account,
    network,
    from,
    fee,
    unsigned,
    rpc,
    independent,
    apis,
    extraFlags: (maxFee) =>
      params.token === undefined
        ? [feeReachesAmount(maxFee, amount) ? "fee-exceeds-amount" : undefined]
        : [],
    intentOf: (request) =>
      ext === undefined || params.token === undefined
        ? decodeSolana(request, from)
        : token2022Intent(decodeSolana(request, from), ext, params.token, amount),
  });
};

type SolanaSignRequest = {
  readonly kind: "solana.transaction";
  readonly network: string;
  readonly account: AccountRef;
  readonly message: Uint8Array;
};

/** Everything after `solana.build`: fee tiers, endpoint cross-check, decode, simulate, submit. */
const finishPrepared = async (
  ctx: RouteContext,
  args: {
    readonly account: Extract<AccountRef, { readonly kind: "hd" }>;
    readonly network: string;
    readonly from: string;
    readonly fee: PrepareParams["fee"];
    readonly unsigned: SolanaUnsignedTransaction;
    readonly rpc: SolanaRpc;
    readonly independent: Independent<SolanaRpc>;
    readonly apis: Pick<ReturnType<typeof chains>, "sign">;
    readonly intentOf: (request: SolanaSignRequest) => DisplayIntent;
    readonly flags?: ReadonlyArray<RequestCheckCode | undefined>;
    readonly extraFlags?: (maxFee: bigint) => Array<RequestCheckCode | undefined>;
    readonly verify?: (maxFee: bigint) => void;
  },
): Promise<PreparedRequest> => {
  const { account, network, from, fee, unsigned, rpc, independent, apis, intentOf } = args;
  const quotes = await solana.estimateFee(rpc, unsigned.writable);
  let quote = quotes.find((q) => q.tier === fee) ?? quotes[1];
  if (quote === undefined) {
    throw new Error("no fee quote");
  }
  const flags: Array<RequestCheckCode | undefined> = [
    independent.kind === "unavailable" ? "reads-unverified" : undefined,
    ...(args.flags ?? []),
  ];
  if (independent.kind === "available") {
    try {
      const others = await solana.estimateFee(independent.client, unsigned.writable);
      const other = others.find((q) => q.tier === quote?.tier);
      if (other === undefined) {
        flags.push("reads-unverified");
      } else {
        const merged = mergeSolanaQuote(quote, other);
        ({ quote } = merged);
        flags.push(
          merged.mismatch ? "fee-mismatch" : undefined,
          exceedsNetworkCap(quote.microLamportsPerCu, other.microLamportsPerCu)
            ? "fee-above-network"
            : undefined,
        );
      }
    } catch {
      flags.push("reads-unverified");
    }
  }
  const units = BigInt(
    Math.ceil((unsigned.unitsConsumed === 0 ? 1_400_000 : unsigned.unitsConsumed) * 1.1),
  );
  const maxFee = BASE_FEE_LAMPORTS + (units * quote.microLamportsPerCu + 999_999n) / 1_000_000n;
  args.verify?.(maxFee);
  flags.push(...(args.extraFlags?.(maxFee) ?? []));
  const messageBytes = solana.applyFee(unsigned, quote);
  const request: SolanaSignRequest = {
    kind: "solana.transaction",
    network,
    account,
    message: messageBytes,
  };
  const intent = intentOf(request);
  const id = newId(ctx.options.random);
  const simulation = await solana.simulate(rpc, network, from, messageBytes, ctx.options.setTimer);

  const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
    let tx: TrackedTransaction = {
      id,
      family: "solana",
      network,
      account: account.walletId,
      hash: undefined,
      state: "draft",
      intent,
      nonce: 0,
      lastValidBlockHeight: Number(unsigned.lastValidBlockHeight),
      submittedAt: ctx.options.now(),
      error: undefined,
    };
    tx = await ctx.transition(tx, {});
    try {
      const result = await apis.sign({ request, verify });
      tx = await ctx.transition(tx, { state: "signed" });
      if (result.kind !== "solana.transaction" || !(result.signature instanceof Uint8Array)) {
        throw new Error("unexpected solana sign result");
      }
      const wire = solana.finalize(messageBytes, [result.signature]);
      const hash = await solana.broadcast(rpc, wire);
      wires.set(id, wire);
      return await submitTx(ctx, tx, hash);
    } catch (error) {
      await failTx(ctx, tx, error);
      throw error;
    }
  };

  return {
    txId: id,
    account,
    network,
    intent,
    checks: collectChecks(flags),
    simulation,
    resimulate: async () => solana.simulate(rpc, network, from, messageBytes, ctx.options.setTimer),
    staleReason: async () =>
      (await solana.blockHeight(rpc)) > unsigned.lastValidBlockHeight
        ? "blockhash expired — start over"
        : undefined,
    submit,
    release: () => undefined,
  };
};

const U64_MAX = 18446744073709551615n;
export const STAKE_SEED_PREFIX = "stake:";
const SEED_SCAN_BATCH = 10;
const SEED_SCAN_LIMIT = 100;

const u64 = (v: unknown): bigint | undefined => {
  const s = str(v, "");
  return /^[0-9]+$/.test(s) ? BigInt(s) : undefined;
};

type ParsedStakeAccount = {
  readonly type: string;
  readonly staker: string | undefined;
  readonly withdrawer: string | undefined;
  readonly delegation:
    | {
        readonly voter: string;
        readonly activationEpoch: bigint;
        readonly deactivationEpoch: bigint;
      }
    | undefined;
};

/** A `getAccountInfo`/`getMultipleAccounts` (jsonParsed) value decoded for the Stake program. */
export const parseStakeAccount = (value: unknown): ParsedStakeAccount | undefined => {
  const parsed = obj(obj(obj(value)?.["data"])?.["parsed"]);
  const info = obj(parsed?.["info"]);
  const meta = obj(info?.["meta"]);
  const authorized = obj(meta?.["authorized"]);
  const type = parsed?.["type"];
  if (typeof type !== "string" || info === undefined) {
    return undefined;
  }
  const delegation = obj(obj(info["stake"])?.["delegation"]);
  const activationEpoch = u64(delegation?.["activationEpoch"]);
  const deactivationEpoch = u64(delegation?.["deactivationEpoch"]);
  const voter = delegation?.["voter"];
  return {
    type,
    staker: typeof authorized?.["staker"] === "string" ? authorized["staker"] : undefined,
    withdrawer:
      typeof authorized?.["withdrawer"] === "string" ? authorized["withdrawer"] : undefined,
    delegation:
      delegation === undefined ||
      activationEpoch === undefined ||
      deactivationEpoch === undefined ||
      typeof voter !== "string"
        ? undefined
        : { voter, activationEpoch, deactivationEpoch },
  };
};

const stakeAccountInfo = async (
  rpc: SolanaRpc,
  stakeAccount: string,
): Promise<{ readonly lamports: bigint; readonly parsed: ParsedStakeAccount }> => {
  const result = obj(
    await rpc.call("getAccountInfo", [
      stakeAccount,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  );
  const value = obj(result?.["value"]);
  if (value === undefined) {
    throw new ChainError("invalid-request", `${stakeAccount} is not a stake account`);
  }
  const parsed = parseStakeAccount(value);
  if (parsed === undefined || obj(value["data"])?.["program"] !== "stake") {
    throw new ChainError("invalid-request", `${stakeAccount} is not a stake account`);
  }
  return { lamports: BigInt(str(value["lamports"])), parsed };
};

const voteIsCurrent = async (rpc: SolanaRpc, vote: string): Promise<boolean> => {
  const result = obj(await rpc.call("getVoteAccounts", [{ commitment: "confirmed" }]));
  return (arr(result?.["current"]) ?? []).some((v) => obj(v)?.["votePubkey"] === vote);
};

/** The smallest `stake:<n>` seed whose derived account does not exist on-chain. */
const nextStakeSeed = async (
  rpc: SolanaRpc,
  from: string,
): Promise<{ readonly seed: string; readonly stakeAccount: string }> => {
  for (let start = 0; start < SEED_SCAN_LIMIT; start += SEED_SCAN_BATCH) {
    const seeds = Array.from(
      { length: SEED_SCAN_BATCH },
      (_, i) => STAKE_SEED_PREFIX + (start + i),
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- each seed batch gates whether the next is fetched
    const derived = await Promise.all(
      seeds.map(async (seed) =>
        createAddressWithSeed({
          baseAddress: address(from),
          programAddress: address(PROGRAM_IDS.stake),
          seed,
        }),
      ),
    );
    const result = obj(
      // oxlint-disable-next-line eslint/no-await-in-loop -- batch reads are sequential by design
      await rpc.call("getMultipleAccounts", [
        derived.map(String),
        { encoding: "base64", commitment: "confirmed" },
      ]),
    );
    const list = arr(result?.["value"]) ?? [];
    for (const [i, candidate] of derived.entries()) {
      if (list[i] === null || list[i] === undefined) {
        return { seed: seeds[i] ?? "", stakeAccount: String(candidate) };
      }
    }
  }
  throw new ChainError("invalid-request", "no free stake account seed");
};

const currentEpoch = async (rpc: SolanaRpc): Promise<bigint> =>
  u64(obj(await rpc.call("getEpochInfo", [{ commitment: "confirmed" }]))?.["epoch"]) ?? 0n;

const actionsEqual = (a: ReadonlyArray<StakeAction>, b: ReadonlyArray<StakeAction>): boolean =>
  a.length === b.length && a.every((action, i) => JSON.stringify(action) === JSON.stringify(b[i]));

/**
 * An internal `solana-stake` request: builds the stake transaction through the same build → fee →
 * apply → simulate → submit path as a SOL send, after checking the delegation rules the chain
 * enforces. The built message must decode to exactly the expected stake action set.
 */
export const prepareSolanaStake = async (
  ctx: RouteContext,
  input: Extract<ChainRequestInput, { method: "solana-stake" }>,
): Promise<PreparedRequest> => {
  const { account, network, action, fee } = input;
  if (account.kind !== "hd") {
    throw new Error("imported accounts are not yet supported");
  }
  const rpc = ctx.options.networks.solanaRpc(network);
  const independent = ctx.options.networks.independentSolanaRpc(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const solAccount = await apis.account({
    walletId: account.walletId,
    groupIndex: account.groupIndex,
    template: "solana.bip44-change",
    network,
  });
  const from = "address" in solAccount ? solAccount.address : "";
  const flags: Array<RequestCheckCode | undefined> = [];

  let intent: SolanaIntent;
  let expected: ReadonlyArray<StakeAction>;
  let verify: ((maxFee: bigint) => void) | undefined;

  if (action.kind === "delegate") {
    const min = u64(
      obj(await rpc.call("getStakeMinimumDelegation", [{ commitment: "confirmed" }]))?.["value"],
    );
    if (min === undefined || action.lamports < min) {
      throw new ChainError(
        "invalid-request",
        `a stake delegation needs at least ${min?.toString(10) ?? "?"} lamports`,
      );
    }
    const primaryVote = await voteIsCurrent(rpc, action.vote);
    if (!primaryVote) {
      throw new ChainError("invalid-request", `${action.vote} is not a current vote account`);
    }
    if (independent.kind === "unavailable") {
      flags.push("reads-unverified");
    } else if (independent.kind === "available") {
      try {
        if (!(await voteIsCurrent(independent.client, action.vote))) {
          throw new ChainError(
            "invalid-request",
            `${action.vote} is not a current vote account on the independent endpoint`,
          );
        }
      } catch (error) {
        if (error instanceof ChainError) {
          throw error;
        }
        flags.push("reads-unverified");
      }
    }
    const { seed, stakeAccount } = await nextStakeSeed(rpc, from);
    const rentResult = await rpc.call("getMinimumBalanceForRentExemption", [STAKE_ACCOUNT_BYTES]);
    const rent = BigInt(str(obj(rentResult)?.["value"] ?? rentResult));
    const balance = BigInt(
      str(obj(await rpc.call("getBalance", [from, { commitment: "confirmed" }]))?.["value"]),
    );
    intent = {
      kind: "stake-delegate",
      seed,
      stakeAccount,
      lamports: action.lamports,
      vote: action.vote,
    };
    expected = [
      { kind: "create", account: stakeAccount, lamports: (action.lamports + rent).toString(10) },
      { kind: "delegate", account: stakeAccount, validator: action.vote },
    ];
    verify = (maxFee) => {
      if (action.lamports + rent + maxFee > balance) {
        throw new ChainError(
          "invalid-request",
          `balance ${balance.toString(10)} does not cover the delegation plus rent and fees`,
        );
      }
    };
  } else if (action.kind === "deactivate") {
    const { parsed } = await stakeAccountInfo(rpc, action.stakeAccount);
    if (parsed.type !== "delegated" || parsed.delegation === undefined) {
      throw new ChainError("invalid-request", `${action.stakeAccount} is not delegated`);
    }
    if (parsed.staker !== from) {
      throw new ChainError("invalid-request", "the staker authority is not this account");
    }
    if (parsed.delegation.deactivationEpoch !== U64_MAX) {
      throw new ChainError("invalid-request", "the stake account is already deactivating");
    }
    intent = { kind: "stake-deactivate", stakeAccount: action.stakeAccount };
    expected = [{ kind: "deactivate", account: action.stakeAccount }];
  } else {
    const { lamports: available, parsed } = await stakeAccountInfo(rpc, action.stakeAccount);
    if (parsed.withdrawer !== from) {
      throw new ChainError("invalid-request", "the withdrawer authority is not this account");
    }
    if (action.lamports > available) {
      throw new ChainError(
        "invalid-request",
        `withdrawing ${action.lamports.toString(10)} exceeds the account's ${available.toString(10)} lamports`,
      );
    }
    const epoch = await currentEpoch(rpc);
    const withdrawable =
      parsed.type === "initialized" ||
      (parsed.delegation !== undefined && parsed.delegation.deactivationEpoch < epoch);
    if (!withdrawable) {
      throw new ChainError(
        "invalid-request",
        "the stake is still delegated or cooling down — withdraw after the cooldown epoch",
      );
    }
    intent = {
      kind: "stake-withdraw",
      stakeAccount: action.stakeAccount,
      lamports: action.lamports,
    };
    expected = [
      {
        kind: "withdraw",
        account: action.stakeAccount,
        to: from,
        lamports: action.lamports.toString(10),
      },
    ];
  }

  const unsigned = await solana.build(rpc, network, from, intent);
  return finishPrepared(ctx, {
    account,
    network,
    from,
    fee,
    unsigned,
    rpc,
    independent,
    apis,
    flags,
    intentOf: (request) => {
      const intent = decodeSolana(request, from);
      if (
        intent.summary !== "stake" ||
        intent.verifiability !== "full" ||
        !actionsEqual(intent.staking ?? [], expected)
      ) {
        throw new ChainError(
          "invalid-request",
          "built transaction did not decode as the expected stake operation",
        );
      }
      return intent;
    },
    ...(verify === undefined ? {} : { verify }),
  });
};

/** Returns the terminal state, `dropped` on blockhash expiry, or `undefined` to keep polling. */
export const pollSolana = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
): Promise<TxState | undefined> => {
  if (tx.hash === undefined) {
    return "failed";
  }
  const rpc = ctx.options.networks.solanaRpc(tx.network);
  const state = await solana.status(rpc, tx.hash);
  if (state !== "pending") {
    wires.delete(tx.id);
    return state === "finalized" ? "confirmed" : state;
  }
  if (
    tx.lastValidBlockHeight !== undefined &&
    (await solana.blockHeight(rpc)) > BigInt(tx.lastValidBlockHeight)
  ) {
    wires.delete(tx.id);
    return "dropped";
  }
  const wire = wires.get(tx.id);
  if (wire !== undefined) {
    await solana.broadcast(rpc, wire).catch(() => "");
  }
  return undefined;
};

/**
 * Folds Token-2022 mint extensions into the decoded intent: a TransferFee mint shows the
 * recipient's net amount (amount − min(amount×bps/10000, maximum)); a TransferHook or
 * PermanentDelegate marks the intent `partial` with a warning. The mint's extension data is not
 * part of the message, so the route attaches what it fetched — decode alone cannot see it.
 */
export const token2022Intent = (
  intent: DisplayIntent,
  ext: MintExtensionSummary,
  mint: string,
  amount: bigint,
): DisplayIntent => {
  const warnings = [...intent.warnings];
  let { outflows } = intent;
  if (ext.transferFee !== undefined) {
    const net = netAfterTransferFee(
      amount,
      ext.transferFee.basisPoints,
      ext.transferFee.maximumFee,
    );
    const withheld = amount - net;
    warnings.push({
      kind: "token-2022-transfer-fee",
      message: `transfer fee withheld ${withheld.toString(10)} base units`,
    });
    outflows = outflows.map((o) =>
      o.amount.asset === mint ? { ...o, amount: { ...o.amount, amount: net.toString(10) } } : o,
    );
  }
  if (ext.transferHook !== undefined || ext.permanentDelegate !== undefined) {
    warnings.push({
      kind: "token-2022-extension",
      message: "mint carries a transfer-hook or permanent-delegate extension",
    });
    return { ...intent, outflows, warnings, verifiability: "partial" };
  }
  return { ...intent, outflows, warnings };
};
