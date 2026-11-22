import { base58, base64 } from "@scure/base";
import {
  getAdvanceNonceAccountDiscriminatorBytes,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  address,
  createAddressWithSeed,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";

import type { StakeAction } from "@qntx/wallet-chains";
import { ChainError } from "@qntx/wallet-chains";
import {
  decodeSolana,
  MPL_CORE_PROGRAM,
  netAfterTransferFee,
  parseCompiledMessage,
  parseMintExtensions,
  PROGRAM_IDS,
} from "@qntx/wallet-chains/solana";
import type { MintExtensionSummary, ParsedSolanaMessage } from "@qntx/wallet-chains/solana";
/** Solana route: SOL/SPL send → sign → broadcast, plus status poll with rebroadcast/drop. */
import { chains } from "@qntx/wallet/chains";

import { STAKE_ACCOUNT_BYTES, SolanaChainAdapter } from "../chains/solana.ts";
import type { SolanaIntent, SolanaUnsignedTransaction } from "../chains/solana.ts";
import { SOLANA_MAINNET } from "../gateway/contract/quotes.ts";
import type { SolanaRpc, Independent } from "../networks/controller.ts";
import {
  collectChecks,
  exceedsNetworkCap,
  feeReachesAmount,
  mergeSolanaQuote,
} from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import { QUOTE_MAX_AGE_MS } from "../swaps/index.ts";
import {
  assertJupiterIntent,
  assertJupiterPrograms,
  assertJupiterSimulation,
  jupiterIx,
  readLookupTable,
} from "../swaps/jupiter.ts";
import { submitSigned } from "./broadcast.ts";
import type { BroadcastVerdict } from "./broadcast.ts";
import { corroborated } from "./drop-evidence.ts";
import type { DropEvidence } from "./drop-evidence.ts";
import type {
  AccountRef,
  ChainRequestInput,
  DisplayIntent,
  PrepareParams,
  PreparedRequest,
  RouteContext,
  SendParams,
  TrackedTransaction,
  TxPoll,
} from "./route.ts";
import {
  accountAddressOf,
  assertGatewayOnlyBinding,
  errorMessage,
  includedPoll,
  newId,
  failTx,
} from "./route.ts";

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

/** Agave `TransactionError::AlreadyProcessed`: this exact transaction has already landed. */
const SOLANA_HELD = /already been processed/i;

/**
 * Agave `sendTransaction` refusals (rpc/src/rpc.rs): a failed preflight simulation, a bad signature
 * or precompile, an unsanitizable message. The node forwards none of them.
 */
const SOLANA_REFUSED =
  /^Transaction simulation failed|signature verification failure|precompile verification failure|^invalid transaction/i;

/**
 * The margin `submittedAt` gets when the nonce account's history must reach back before it:
 * device-clock skew against a block's `blockTime` — the larger the margin, the more conservative
 * the `dropped` proof.
 */
const SOLANA_HISTORY_SKEW_MS = 600_000;

/**
 * The span a `dropped` streak without a host endpoint must outlast: one processing age. A blockhash
 * is accepted for MAX_PROCESSING_AGE = MAX_RECENT_BLOCKHASHES / 2 = 150 blocks (anza-xyz/solana-sdk
 * clock/src/lib.rs `MAX_PROCESSING_AGE`; agave runtime/src/bank.rs `is_blockhash_valid` →
 * `is_hash_valid_for_age`, `get_blockhash_last_valid_block_height` = block_height +
 * max_processing_age − age), and 400 ms is the longest target slot time the cluster has run
 * (`DEFAULT_MS_PER_SLOT_400_MS`; SIMD-0525 only lowers it, `MAX_HASH_AGE_IN_SECONDS_400_MS` for the
 * 300-hash queue) — so a streak longer than one age outlasts any blockhash a lagging upstream could
 * still have called valid when the streak began.
 */
const SOLANA_DROP_SPAN_MS = 150 * 400;

/**
 * What a failed `sendTransaction` says about the bytes. A preflight "Blockhash not found" is the
 * node lagging behind the blockhash, not the transaction: it stays unknown until the blockhash
 * expiry settles it.
 */
export const solanaBroadcastVerdict = (error: unknown): BroadcastVerdict => {
  const message = errorMessage(error);
  if (SOLANA_HELD.test(message)) {
    return "held";
  }
  return SOLANA_REFUSED.test(message) && !/blockhash not found/i.test(message)
    ? "refused"
    : undefined;
};

/** Whether the cluster has seen `signature` at any commitment. */
const signatureSeen = async (rpc: SolanaRpc, signature: string): Promise<boolean> => {
  const result = obj(
    await rpc.call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]),
  );
  return obj(arr(result?.["value"])?.[0]) !== undefined;
};

const NONCE_DISCRIMINATOR = getAdvanceNonceAccountDiscriminatorBytes();

/**
 * The durable-nonce lifetime a compiled message carries: only when instruction 0 is System
 * AdvanceNonceAccount is the transaction durable — anything else is blockhash-lifetime. The nonce
 * account is that instruction's first account — or undefined when its index resolves into a lookup
 * table, which on chain it still does — and the nonce it holds is the message's lifetime token.
 */
export const durableNonceOfMessage = (
  messageBytes: Uint8Array,
): { readonly account: string | undefined; readonly value: string } | undefined => {
  /* `parseCompiledMessage` maps every supported version onto one model — kit's own decoder
     gives a v1 message instruction headers/payloads instead of `instructions`, which would
     silently misclassify a v1 durable nonce. A message that fails to parse is not
     blockhash-lifetime: the error propagates so the poll cannot misclassify a durable
     transaction and drop it while it can still land. */
  const compiled: ParsedSolanaMessage = parseCompiledMessage(messageBytes);
  const [first] = compiled.instructions;
  const data = first?.data;
  const accountIndices = first?.accountIndices;
  if (first === undefined || data === undefined || accountIndices === undefined) {
    return undefined;
  }
  const program = compiled.staticAccounts[first.programAddressIndex];
  const [nonceIndex] = accountIndices;
  const nonceAccount = nonceIndex === undefined ? undefined : compiled.staticAccounts[nonceIndex];
  if (
    program !== SYSTEM_PROGRAM_ADDRESS ||
    data.length < NONCE_DISCRIMINATOR.length ||
    NONCE_DISCRIMINATOR.some((byte, index) => data[index] !== byte)
  ) {
    return undefined;
  }
  return {
    account: nonceAccount,
    value: compiled.lifetimeToken,
  };
};

/** The blockhash a persisted wire commits to; `undefined` when it cannot be decoded. */
const lifetimeTokenOf = (raw: string): string | undefined => {
  try {
    const wire = base64.decode(raw);
    const compiled = getCompiledTransactionMessageDecoder().decode(
      new Uint8Array(getTransactionDecoder().decode(wire).messageBytes),
    );
    return compiled.lifetimeToken;
  } catch {
    return undefined;
  }
};

export const prepareSolana = async (
  ctx: RouteContext,
  params: PrepareParams,
): Promise<PreparedRequest> => {
  const { account, network, to, amount, fee } = params;
  const rpc = ctx.options.networks.solanaRpc(network);
  const independent = ctx.options.networks.independentSolanaRpc(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const from = await accountAddressOf(ctx, account, "solana.bip44-change", network);
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
        const epoch = u64(obj(await rpc.call("getEpochInfo", []))?.["epoch"]);
        if (epoch === undefined) {
          throw new TypeError("getEpochInfo: malformed epoch");
        }
        ext = parseMintExtensions(raw, epoch);
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
    readonly account: AccountRef;
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
    readonly lookupTables?: ReadonlyArray<{
      readonly address: string;
      readonly addresses: ReadonlyArray<string>;
    }>;
  },
): Promise<PreparedRequest> => {
  const { account, network, from, fee, unsigned, rpc, independent, apis, intentOf } = args;
  /* The recent blockhash is the chain binding of the signed bytes: when the gateway may be
     answering it has to be confirmed by a host endpoint, and both endpoints' genesis must be the
     configured cluster's — a provider on another cluster would otherwise sign a valid-looking
     wire for the wrong chain. `build` read the blockhash at `confirmed`; `isBlockhashValid` is
     asked at `processed`, the freshest bank, so a host a few slots behind still knows it. */
  const info = ctx.options.networks.info(network);
  if (independent.kind === "unavailable") {
    assertGatewayOnlyBinding(info, "recent blockhash");
    if ((await solana.genesisHash(rpc)) !== info.genesisHash) {
      throw new ChainError("invalid-request", `the endpoint serves another chain than ${network}`);
    }
  }
  if (independent.kind === "available") {
    if ((await solana.genesisHash(rpc)) !== info.genesisHash) {
      throw new ChainError("invalid-request", `the endpoint serves another chain than ${network}`);
    }
    let hostGenesis: string | undefined;
    let hostValid: { readonly valid: boolean; readonly slot: bigint | undefined } | undefined;
    try {
      hostGenesis = await solana.genesisHash(independent.client);
      hostValid = await solana.blockhashValid(independent.client, unsigned.blockhash);
    } catch {
      throw new ChainError(
        "invalid-request",
        "the host endpoint could not confirm the recent blockhash",
      );
    }
    if (hostGenesis !== info.genesisHash) {
      throw new ChainError("invalid-request", `the endpoint serves another chain than ${network}`);
    }
    if (hostValid !== undefined && !hostValid.valid) {
      throw new ChainError(
        "invalid-request",
        "the host endpoint does not know the recent blockhash — try again",
      );
    }
  }
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
    ...(args.lookupTables === undefined ? {} : { lookupTables: args.lookupTables }),
  };
  const intent = intentOf(request);
  const id = newId(ctx.options.random);
  const simulation = await solana.simulate(rpc, network, from, messageBytes, ctx.options.setTimer);

  const submit = async (
    verify: SendParams["verify"],
    commit: () => void,
  ): Promise<TrackedTransaction> => {
    const durable = durableNonceOfMessage(new Uint8Array(messageBytes));
    let tx: TrackedTransaction = {
      id,
      family: "solana",
      network,
      account: account.kind === "hd" ? account.walletId : account.keyId,
      hash: undefined,
      state: "draft",
      intent,
      nonce: 0,
      ...(durable === undefined
        ? { lastValidBlockHeight: Number(unsigned.lastValidBlockHeight) }
        : { durableNonce: durable }),
      submittedAt: ctx.options.now(),
      error: undefined,
    };
    tx = await ctx.transition(tx, {});
    let wire: Uint8Array;
    let signature: string;
    try {
      const result = await apis.sign({ request, verify });
      tx = await ctx.transition(tx, { state: "signed" });
      if (result.kind !== "solana.transaction" || !(result.signature instanceof Uint8Array)) {
        throw new Error("unexpected solana sign result");
      }
      wire = solana.finalize(messageBytes, [result.signature]);
      signature = base58.encode(result.signature);
      commit();
    } catch (error) {
      await failTx(ctx, tx, error);
      throw error;
    }
    // The fee payer's signature is the transaction id; the blockhash expiry bounds how long an
    // unknown outcome can stay open.
    return submitSigned(ctx, tx, {
      id: signature,
      raw: base64.encode(wire),
      hold: () => undefined,
      release: () => undefined,
      send: async () => solana.broadcast(rpc, wire),
      verdict: solanaBroadcastVerdict,
      known: async () => signatureSeen(rpc, signature),
    });
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
      (await solana.blockHeight(rpc, "confirmed")) > unsigned.lastValidBlockHeight
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
  const lamports = u64(value["lamports"]);
  if (lamports === undefined) {
    throw new TypeError("getAccountInfo: malformed lamports");
  }
  return { lamports, parsed };
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
    // The spec guarantees one slot per requested address; a short list is not "all seeds free".
    const list = arr(result?.["value"]);
    if (list === undefined || list.length !== derived.length) {
      throw new TypeError("getMultipleAccounts: malformed value");
    }
    for (const [i, candidate] of derived.entries()) {
      if (list[i] === null || list[i] === undefined) {
        return { seed: seeds[i] ?? "", stakeAccount: String(candidate) };
      }
    }
  }
  throw new ChainError("invalid-request", "no free stake account seed");
};

const currentEpoch = async (rpc: SolanaRpc): Promise<bigint> => {
  const epoch = u64(obj(await rpc.call("getEpochInfo", [{ commitment: "confirmed" }]))?.["epoch"]);
  if (epoch === undefined) {
    throw new TypeError("getEpochInfo: malformed epoch");
  }
  return epoch;
};

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
  const rpc = ctx.options.networks.solanaRpc(network);
  const independent = ctx.options.networks.independentSolanaRpc(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const from = await accountAddressOf(ctx, account, "solana.bip44-change", network);
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
    if (independent.kind === "available") {
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
    /* The route reads the rent-exempt reserve once: the intent carries it to `build` so the
       create instruction and the expected/balance checks share one strictly-read value. */
    const rentResult = await rpc.call("getMinimumBalanceForRentExemption", [STAKE_ACCOUNT_BYTES]);
    const rent = u64(obj(rentResult)?.["value"] ?? rentResult);
    if (rent === undefined) {
      throw new TypeError("getMinimumBalanceForRentExemption: malformed value");
    }
    const balance = u64(
      obj(await rpc.call("getBalance", [from, { commitment: "confirmed" }]))?.["value"],
    );
    if (balance === undefined) {
      throw new TypeError("getBalance: malformed value");
    }
    intent = {
      kind: "stake-delegate",
      seed,
      stakeAccount,
      lamports: action.lamports,
      rent,
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
/** A `getAccountInfo` response value for a Core asset — owner + raw account bytes. */
const coreAssetAccount = async (rpc: SolanaRpc, asset: string): Promise<Uint8Array> => {
  const info = await rpc.call("getAccountInfo", [
    asset,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const value = obj(info)?.["value"];
  if (value === null || value === undefined || obj(value)?.["owner"] !== MPL_CORE_PROGRAM) {
    throw new ChainError("invalid-request", "the asset is not a Metaplex Core account");
  }
  const raw = arr(obj(value)?.["data"])?.[0];
  if (typeof raw !== "string") {
    throw new ChainError("invalid-request", "the asset account has no data");
  }
  return base64.decode(raw);
};

const CORE_KEY_ASSET_V1 = 1;
const CORE_UPDATE_AUTHORITY_COLLECTION = 2;

export const prepareSolanaCoreSend = async (
  ctx: RouteContext,
  input: Extract<ChainRequestInput, { method: "solana-core-send" }>,
): Promise<PreparedRequest> => {
  const { account, network, asset, to, fee } = input;
  const rpc = ctx.options.networks.solanaRpc(network);
  const independent = ctx.options.networks.independentSolanaRpc(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const from = await accountAddressOf(ctx, account, "solana.bip44-change", network);
  const flags: Array<RequestCheckCode | undefined> = [];
  const data = await coreAssetAccount(rpc, asset);
  if (independent.kind === "available") {
    try {
      const other = await coreAssetAccount(independent.client, asset);
      if (data.length !== other.length || !data.every((b, i) => b === other[i])) {
        throw new ChainError("invalid-request", "the endpoints disagree on the asset account");
      }
    } catch (error) {
      if (error instanceof ChainError) {
        throw error;
      }
      flags.push("reads-unverified");
    }
  }
  /* AssetV1 layout: key u8 at 0, owner pubkey at 1-32, updateAuthority enum at 33. */
  if (data.length < 66 || data[0] !== CORE_KEY_ASSET_V1) {
    throw new ChainError("invalid-request", "the account is not an mpl-core asset");
  }
  if (base58.encode(data.slice(1, 33)) !== from) {
    throw new ChainError("invalid-request", "the account does not own the asset");
  }
  const collection =
    data[33] === CORE_UPDATE_AUTHORITY_COLLECTION
      ? base58.encode(data.slice(34, 66))
      : MPL_CORE_PROGRAM;
  const unsigned = await solana.build(rpc, network, from, {
    kind: "instructions",
    instructions: [
      jupiterIx({
        programId: MPL_CORE_PROGRAM,
        accounts: [
          { address: asset, signer: false, writable: true },
          { address: collection, signer: false, writable: false },
          { address: from, signer: true, writable: true },
          { address: from, signer: true, writable: false },
          { address: to, signer: false, writable: false },
          { address: MPL_CORE_PROGRAM, signer: false, writable: false },
          { address: MPL_CORE_PROGRAM, signer: false, writable: false },
        ],
        /* mpl-core IDL at c8732ac: TransferV1 disc 14, args {compressionProof: None}. */
        data: Uint8Array.from([14, 0]),
      }),
    ],
    lookupTables: [],
  });
  return finishPrepared(ctx, {
    account,
    network,
    from,
    fee,
    unsigned,
    rpc,
    independent,
    apis,
    intentOf: (request) => {
      const intent = decodeSolana(request, from);
      const [outflow] = intent.outflows;
      if (
        intent.summary !== "transfer" ||
        intent.outflows.length !== 1 ||
        outflow === undefined ||
        outflow.to !== to ||
        outflow.amount.asset !== asset ||
        outflow.amount.amount !== "1"
      ) {
        throw new ChainError("invalid-request", "the built transfer does not decode to the send");
      }
      return intent;
    },
    flags,
  });
};

/**
 * A dApp-signed transaction joins tracking like a wallet send: the signed wire and its locally
 * computed id — the fee payer's signature — are persisted before anything leaves, so a lost answer
 * stays `submitted` under that id. `lastValidBlockHeight` is the caller's bound on the blockhash's
 * expiry (the message carries only the blockhash).
 */
export const submitDappSolana = async (
  ctx: RouteContext,
  params: {
    readonly network: string;
    readonly walletId: string;
    readonly wire: Uint8Array;
    readonly lastValidBlockHeight: bigint;
    readonly intent: DisplayIntent;
  },
): Promise<string> => {
  const { network, walletId, wire, lastValidBlockHeight, intent } = params;
  const rpc = ctx.options.networks.solanaRpc(network);
  const compiled = getTransactionDecoder().decode(wire);
  const signature: string = getSignatureFromTransaction(compiled);
  const durable = durableNonceOfMessage(new Uint8Array(compiled.messageBytes));
  let tx: TrackedTransaction = {
    id: ctx.newId(),
    family: "solana",
    network,
    account: walletId,
    hash: undefined,
    state: "signed",
    intent,
    nonce: 0,
    ...(durable === undefined
      ? { lastValidBlockHeight: Number(lastValidBlockHeight) }
      : { durableNonce: durable }),
    submittedAt: ctx.options.now(),
    error: undefined,
  };
  tx = await ctx.transition(tx, {});
  await submitSigned(ctx, tx, {
    id: signature,
    raw: base64.encode(wire),
    hold: () => undefined,
    release: () => undefined,
    send: async () => solana.broadcast(rpc, wire),
    verdict: solanaBroadcastVerdict,
    known: async () => signatureSeen(rpc, signature),
  });
  return signature;
};

/**
 * What one endpoint's reads settle a poll to: an inclusion it observed, the `dropped` verdict it
 * claims — or nothing proven — plus whether the transaction can still land on its view, in which
 * case the wire keeps going out.
 */
type SolanaPollProof = {
  readonly poll: TxPoll | undefined;
  readonly rebroadcast: boolean;
};

/** A confirmed-or-better status entry settles the poll directly. */
const entrySettles = (entry: {
  readonly slot: number;
  readonly commitment: "processed" | "confirmed" | "finalized";
  readonly failed: boolean;
}): TxPoll => ({
  kind: "included",
  state: entry.failed ? "failed" : "confirmed",
  block: { height: entry.slot },
  final: entry.commitment === "finalized",
});

/* The durable-nonce drop proof, run against one client so the verdict's reads all come from the
   same upstream. A durable nonce never expires by height — the nonce account's current value is
   the proof. It is read at finalized before the status, so a value that advanced between the
   reads can never be finalised `dropped` by an answer a stale bank produced. A lookup-loaded
   account cannot be read back, so that transaction is only ever settled by landing. */
const proveDurableDrop = async (
  rpc: SolanaRpc,
  tx: TrackedTransaction,
  durable: NonNullable<TrackedTransaction["durableNonce"]>,
  hash: string,
): Promise<SolanaPollProof> => {
  const nonceAccount = durable.account;
  const nonce = nonceAccount === undefined ? undefined : await solana.nonceValue(rpc, nonceAccount);
  const status = await solana.signatureStatus(rpc, hash);
  const { entry } = status;
  if (entry !== undefined && (entry.failed || entry.commitment !== "processed")) {
    return { poll: entrySettles(entry), rebroadcast: false };
  }
  /* The nonce advanced (or the account is gone) and a bank at least as fresh as the finalized
     read has no entry at any commitment. A null status is not yet the drop: the status lookup
     only reaches back as far as the node's ledger, so a transaction that consumed the nonce
     long ago can still read absent. The nonce account's own signature history is the proof:
     ours listed settles the transaction from that entry; absent is `dropped` only when the
     listing provably reaches back before we submitted — an entry whose blockTime predates
     `submittedAt` by more than the clock-skew margin. A short, young or blockTime-less
     listing, or a failed read, proves nothing: keep tracking (never rebroadcast — the nonce
     is consumed). */
  if (
    nonce !== undefined &&
    nonce.value !== durable.value &&
    status.entry === undefined &&
    status.slot !== undefined &&
    nonce.slot !== undefined &&
    status.slot >= nonce.slot &&
    nonceAccount !== undefined
  ) {
    const history = await solana.signaturesForAddress(rpc, nonceAccount).catch(() => undefined);
    const ours = history?.find((e) => e.signature === hash);
    if (ours !== undefined) {
      return {
        poll: {
          kind: "included",
          state: ours.err === null || ours.err === undefined ? "confirmed" : "failed",
          block: { height: ours.slot },
          final: ours.confirmationStatus === "finalized",
        },
        rebroadcast: false,
      };
    }
    const coversWindow =
      history?.some(
        (e) =>
          e.blockTime !== undefined && e.blockTime * 1000 < tx.submittedAt - SOLANA_HISTORY_SKEW_MS,
      ) === true;
    return {
      poll: coversWindow ? { kind: "ended", state: "dropped" } : undefined,
      rebroadcast: false,
    };
  }
  /* Nothing proven — but a nonce that already moved is never rebroadcast onto. */
  const consumed = nonce !== undefined && nonce.value !== durable.value;
  return { poll: undefined, rebroadcast: !consumed };
};

/* The blockhash drop proof, run against one client. With a blockhash bound the tip is read first,
   then — only when the height alone says expired — the blockhash's own validity on the same
   endpoint, then the status: a transaction landing between the reads can never be finalised
   `dropped` by an answer a stale bank produced. The stored bound was read at request time —
   possibly from an endpoint behind the cluster — so it can sit below the blockhash's true expiry;
   `isBlockhashValid` is the authoritative check, and a raw that cannot be decoded proves
   nothing. */
const proveBlockhashDrop = async (
  rpc: SolanaRpc,
  tx: TrackedTransaction,
  hash: string,
): Promise<SolanaPollProof> => {
  const tip = tx.lastValidBlockHeight === undefined ? undefined : await solana.tip(rpc);
  const expired = tip !== undefined && tip.height > BigInt(tx.lastValidBlockHeight ?? 0);
  const validity = expired
    ? await (async () => {
        const blockhash = tx.raw === undefined ? undefined : lifetimeTokenOf(tx.raw);
        return blockhash === undefined ? undefined : solana.blockhashValid(rpc, blockhash);
      })()
    : undefined;
  const status = await solana.signatureStatus(rpc, hash);
  const { entry } = status;
  if (entry !== undefined && (entry.failed || entry.commitment !== "processed")) {
    return { poll: entrySettles(entry), rebroadcast: false };
  }
  if (!expired || tip === undefined) {
    return { poll: undefined, rebroadcast: true };
  }
  if (validity === undefined) {
    // the wire's blockhash cannot be read — the drop is not proven
    return { poll: undefined, rebroadcast: false };
  }
  const bankFloor =
    validity.slot !== undefined && validity.slot > tip.slot ? validity.slot : tip.slot;
  /* Invalid on this endpoint, no entry at any commitment, and a status bank at least as far
     along as the tip and the validity read: `dropped` claimed. Anything else — a stale-bank
     status, a processed-only entry — stays tracked and is not rebroadcast: a dead blockhash
     can only hit "already processed" or nothing. A still-valid one keeps the wire going out. */
  if (
    !validity.valid &&
    status.entry === undefined &&
    status.slot !== undefined &&
    status.slot >= bankFloor
  ) {
    return { poll: { kind: "ended", state: "dropped" }, rebroadcast: false };
  }
  return { poll: undefined, rebroadcast: validity.valid };
};

/* A `dropped` claim from one upstream is only a claim. A configured host endpoint re-runs the
   whole proof on its own pinned client: agreement ends the row `dropped`, an entry it surfaces
   settles the inclusion, an unfinished proof or a failed read keeps tracking. With no host
   endpoint — none configured, or the host endpoint already is the primary — the same picture
   must hold for a streak of consecutive polls spanning more than one processing age. */
const settleSolanaDrop = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
  evidence: DropEvidence,
  prove: (rpc: SolanaRpc) => Promise<SolanaPollProof>,
): Promise<TxPoll | undefined> => {
  const independent = ctx.options.networks.independentPinnedSolanaRpc(tx.network);
  if (independent.kind === "available") {
    const theirs = await prove(independent.client).catch(() => undefined);
    evidence.delete(tx.id);
    return theirs?.poll;
  }
  if (corroborated(ctx.options.now(), evidence, tx.id, SOLANA_DROP_SPAN_MS)) {
    evidence.delete(tx.id);
    return { kind: "ended", state: "dropped" };
  }
  return undefined;
};

export const pollSolana = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
  evidence: DropEvidence,
): Promise<TxPoll | undefined> => {
  if (tx.hash === undefined) {
    return { kind: "ended", state: "failed" };
  }
  const { hash } = tx;
  /* Every read of one poll goes through one pinned upstream: a tip from one node mixed with a
     validity, status or nonce answer from another would "prove" a drop that neither node alone
     claims. */
  const rpc = ctx.options.networks.pinnedSolanaRpc(tx.network);
  try {
    if (tx.block !== undefined) {
      /* The finality recheck: the entry reports its commitment. No entry, or only a processed one,
         proves a reorg only when the answering bank is already at or past the persisted slot and
         the entry — if any — names a different one; a bank behind the slot proves nothing. */
      const status = await solana.signatureStatus(rpc, tx.hash);
      const { entry } = status;
      if (entry !== undefined && (entry.failed || entry.commitment !== "processed")) {
        return includedPoll(
          tx,
          entry.failed ? "failed" : "confirmed",
          { height: entry.slot },
          entry.commitment === "finalized",
        );
      }
      return status.slot !== undefined &&
        status.slot >= BigInt(tx.block.height) &&
        (entry === undefined || entry.slot !== tx.block.height)
        ? { kind: "reorged" }
        : undefined;
    }
    const durable = tx.durableNonce;
    const prove =
      durable === undefined
        ? async (r: SolanaRpc) => proveBlockhashDrop(r, tx, hash)
        : async (r: SolanaRpc) => proveDurableDrop(r, tx, durable, hash);
    const proof = await prove(rpc);
    if (proof.poll !== undefined) {
      if (proof.poll.kind === "ended" && proof.poll.state === "dropped") {
        return await settleSolanaDrop(ctx, tx, evidence, prove);
      }
      evidence.delete(tx.id);
      return proof.poll;
    }
    evidence.delete(tx.id);
    /* Never rebroadcast a dead blockhash or a consumed nonce — the wire only leaves while the
       transaction could still land. */
    if (proof.rebroadcast && tx.raw !== undefined && tx.rebroadcast !== false) {
      await solana.broadcast(rpc, base64.decode(tx.raw)).catch(() => "");
    }
    return undefined;
  } catch (error) {
    /* A failed read proves nothing — it also clears any streak the row had collected. */
    evidence.delete(tx.id);
    throw error;
  }
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

/** A table read on one endpoint — owner check plus the decoded address list, or a refusal. */
const readTable = async (rpc: SolanaRpc, table: string): Promise<ReadonlyArray<string>> => {
  const result = obj(
    await rpc.call("getAccountInfo", [table, { encoding: "base64", commitment: "confirmed" }]),
  );
  const value = obj(result?.["value"]);
  const raw = Array.isArray(value?.["data"]) ? (value["data"] as unknown[]) : undefined;
  const data = raw !== undefined && raw.every((x) => typeof x === "string") ? raw[0] : undefined;
  if (value === undefined || typeof value["owner"] !== "string" || data === undefined) {
    throw new ChainError("invalid-request", `the swap lookup table ${table} is not on chain`);
  }
  return readLookupTable(value["owner"], base64.decode(data));
};

export const prepareSolanaSwap = async (
  ctx: RouteContext,
  input: Extract<ChainRequestInput, { method: "solana-swap" }>,
): Promise<PreparedRequest> => {
  const { account, network, quote, fee } = input;
  if (network !== SOLANA_MAINNET) {
    throw new ChainError("invalid-request", "Jupiter swaps are mainnet-only");
  }
  if (ctx.options.now() - quote.fetchedAt > QUOTE_MAX_AGE_MS) {
    throw new ChainError("invalid-request", "the swap quote is stale — fetch a fresh one");
  }
  const rpc = ctx.options.networks.solanaRpc(network);
  const independent = ctx.options.networks.independentSolanaRpc(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const from = await accountAddressOf(ctx, account, "solana.bip44-change", network);
  if (quote.taker !== from) {
    throw new ChainError("invalid-request", "the swap quote is for a different taker");
  }
  assertJupiterPrograms(quote);

  const flags: Array<RequestCheckCode | undefined> = [];
  const tables = await Promise.all(
    quote.lookupTables.map(async (table) => {
      const addresses = await readTable(rpc, table);
      if (independent.kind === "available") {
        try {
          const other = await readTable(independent.client, table);
          if (other.length !== addresses.length || other.some((a, i) => a !== addresses[i])) {
            throw new ChainError(
              "invalid-request",
              "the endpoints disagree on a swap lookup table",
            );
          }
        } catch (error) {
          if (error instanceof ChainError) {
            throw error;
          }
          flags.push("reads-unverified");
        }
      }
      return { address: table, addresses };
    }),
  );

  const all = [...quote.setup, quote.swap, ...(quote.cleanup === undefined ? [] : [quote.cleanup])];
  let unsigned: SolanaUnsignedTransaction;
  try {
    unsigned = await solana.build(rpc, network, from, {
      kind: "instructions",
      instructions: all.map(jupiterIx),
      lookupTables: tables,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("compiled message is")) {
      throw new ChainError(
        "invalid-request",
        "the swap's instructions exceed the transaction size limit",
      );
    }
    throw error;
  }
  const prepared = await finishPrepared(ctx, {
    account,
    network,
    from,
    fee,
    unsigned,
    rpc,
    independent,
    apis,
    intentOf: (request) => {
      const intent = decodeSolana(request, from);
      assertJupiterIntent(quote, intent, from);
      return intent;
    },
    flags,
    lookupTables: tables,
  });
  const maxFee = BigInt(prepared.intent.fee?.max.amount ?? "0");
  assertJupiterSimulation(quote, prepared.simulation, maxFee);
  const rerun = prepared.resimulate;
  const resimulate =
    rerun === undefined
      ? undefined
      : async () => {
          const outcome = await rerun();
          assertJupiterSimulation(quote, outcome, maxFee);
          return outcome;
        };
  return { ...prepared, ...(resimulate === undefined ? {} : { resimulate }) };
};
