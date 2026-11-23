/**
 * The Arbitrum One JSON-RPC the Fiat24 lane's tests run against: an answer source for the world's
 * `arb1` option that replays the SDK's own scripted call tables (`eth_call` decodes against the
 * shipped ABIs and answers per-function queues), storage slots, logs, tx-pool methods and the
 * fee/gas methods the engine's transaction build needs, plus a `eth_sendRawTransaction` sink that
 * captures broadcasts and mines them on `mine()`.
 *
 * Ported from the SDK's test stubs — ~/Desktop/qntx/fiat24/packages/fiat24/tests/chain/stub.ts and
 * tests/flows/stub.ts (same org; MIT OR Apache-2.0) — adapted to answer raw JSON-RPC instead of a
 * viem custom transport, and to serve the engine's tx-build methods.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  erc20Abi,
  getAbiItem,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toEventSelector,
  zeroAddress,
} from "viem";
import type { Abi, Address, Hash, Hex, TransactionSerialized } from "viem";

import { arbitrum as deployment } from "@qntx/fiat24";
import {
  accountAbi,
  cardAbi,
  depositAbi,
  f24Abi,
  f24SalesAbi,
  priceListAbi,
  proxyAdminAbi,
  tokenAbi,
} from "@qntx/fiat24/abi";

import { arb1Error } from "../apps-helpers.ts";
import type { Arb1Rpc } from "../apps-helpers.ts";

export const B = 526365924n;
export const B_HEX: Hex = `0x${B.toString(16)}`;
export const TIMESTAMP = 1_700_000_000n;
export const SENDER_ID = 469709n;
export const RECEIVER_ID = 402001n;
export const AMOUNT = 100n;

export type RecordedRequest = { readonly method: string; readonly params: unknown };

export type DecodedCall = {
  readonly to: Address | undefined;
  readonly functionName: string | undefined;
  readonly args: ReadonlyArray<unknown> | undefined;
  readonly blockTag: string | undefined;
};

export type CallAnswer =
  | { readonly result: unknown }
  | { readonly raw: Hex }
  | { readonly revert: Hex };

export type CallEntry = {
  readonly args?: ReadonlyArray<unknown>;
  readonly answer: CallAnswer;
};

const C = deployment;
const ACCOUNT = C.account.proxy;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;
const PRICELIST_SLOT = "0x167" as Hex;
const F24_SLOT = "0x166" as Hex;
const F24SALES_SLOT = "0x16c" as Hex;
const USDC_SLOT = "0xd0" as Hex;
const ZERO_WORD: Hex = `0x${"0".repeat(64)}`;

const ABIS_BY_ADDRESS = new Map<string, Abi>([
  [ACCOUNT.toLowerCase(), accountAbi],
  [C.tokens.USD24.proxy.toLowerCase(), tokenAbi],
  [C.tokens.EUR24.proxy.toLowerCase(), tokenAbi],
  [C.tokens.CHF24.proxy.toLowerCase(), tokenAbi],
  [C.tokens.CNH24.proxy.toLowerCase(), tokenAbi],
  [C.deposit.proxy.toLowerCase(), depositAbi],
  [C.card.proxy.toLowerCase(), cardAbi],
  [C.priceList.proxy.toLowerCase(), priceListAbi],
  [C.f24Sales.proxy.toLowerCase(), f24SalesAbi],
  [C.f24.address.toLowerCase(), f24Abi],
  [C.proxyAdmin.address.toLowerCase(), proxyAdminAbi],
  [C.usdc.toLowerCase(), erc20Abi],
]);

export function word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function addressTopic(address: Address): Hex {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

export function wordWithAddress(address: Address, head = ""): Hex {
  return `0x${head.padStart(24, "0")}${address.toLowerCase().slice(2)}` as Hex;
}

/** The honest deployment table (impl+admin pins plus the account/deposit wiring slots). */
export function honestStorage(): Map<string, Hex> {
  const table = new Map<string, Hex>();
  for (const pin of [
    C.account,
    C.tokens.USD24,
    C.tokens.EUR24,
    C.tokens.CHF24,
    C.tokens.CNH24,
    C.deposit,
    C.card,
    C.priceList,
    C.f24Sales,
  ]) {
    table.set(`${pin.proxy.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(pin.implementation));
    table.set(`${pin.proxy.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(pin.admin));
  }
  const priceList = C.priceList.proxy.toLowerCase().slice(2);
  table.set(
    `${ACCOUNT.toLowerCase()}:${PRICELIST_SLOT}`,
    `0x${"0".repeat(22)}01${priceList}` as Hex,
  );
  const f24 = C.f24.address.toLowerCase().slice(2);
  table.set(`${ACCOUNT.toLowerCase()}:${F24_SLOT}`, `0x${"0".repeat(20)}${f24}0600` as Hex);
  table.set(`${ACCOUNT.toLowerCase()}:${F24SALES_SLOT}`, wordWithAddress(C.f24Sales.proxy));
  table.set(`${C.deposit.proxy.toLowerCase()}:${USDC_SLOT}`, wordWithAddress(C.usdc));
  return table;
}

export function push(table: Map<string, CallEntry[]>, key: string, entry: CallEntry): void {
  const prev = table.get(key);
  if (prev === undefined) {
    table.set(key, [entry]);
  } else {
    prev.push(entry);
  }
}

export function mergeCalls(...tables: Array<Map<string, CallEntry[]>>): Map<string, CallEntry[]> {
  const out = new Map<string, CallEntry[]>();
  for (const table of tables) {
    for (const [key, entries] of table) {
      const prev = out.get(key);
      if (prev === undefined) {
        out.set(key, [...entries]);
      } else {
        prev.push(...entries);
      }
    }
  }
  return out;
}

/**
 * Merges two parties' call tables in _request_ order: resolveAccount resolves both parties
 * concurrently, so per-key calls arrive `a1, b1, a2, b2, …` and queues must match exactly.
 */
export function interleaveCalls(
  a: Map<string, CallEntry[]>,
  b: Map<string, CallEntry[]>,
): Map<string, CallEntry[]> {
  const out = new Map<string, CallEntry[]>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const ae = a.get(key) ?? [];
    const be = b.get(key) ?? [];
    const merged: CallEntry[] = [];
    for (let i = 0; i < Math.max(ae.length, be.length); i++) {
      const av = ae[i];
      const bv = be[i];
      if (av !== undefined) {
        merged.push(av);
      }
      if (bv !== undefined) {
        merged.push(bv);
      }
    }
    out.set(key, merged);
  }
  return out;
}

export type PartyOpts = {
  readonly historic?: bigint;
  readonly balance?: bigint;
  readonly indexId?: bigint;
  readonly exists?: boolean;
  readonly statusIndex?: number;
  readonly owner?: Address;
};

const accountKey = (fn: string) => `${ACCOUNT.toLowerCase()}:${fn}`;

/** The `resolveAccount`/`getAccount` entries in issue order; `rounds` repeats every entry. */
export function accountEntries(
  who: Address,
  opts: PartyOpts & { readonly rounds?: number } = {},
): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  const historic = opts.historic ?? SENDER_ID;
  const balance = opts.balance ?? 1n;
  const readId = historic === 0n ? (opts.indexId ?? 0n) : historic;
  const exists = opts.exists ?? true;
  const rounds = opts.rounds ?? 1;
  push(entries, accountKey("historicOwnership"), { args: [who], answer: { result: historic } });
  push(entries, accountKey("balanceOf"), { args: [who], answer: { result: balance } });
  if (historic === 0n && balance === 0n) {
    return entries;
  }
  if (historic === 0n) {
    push(entries, accountKey("tokenOfOwnerByIndex"), {
      args: [who, 0n],
      answer: { result: readId },
    });
  }
  push(entries, accountKey("exists"), { args: [readId], answer: { result: exists } });
  push(entries, accountKey("status"), {
    args: [readId],
    answer: { result: opts.statusIndex ?? 5 },
  });
  push(entries, accountKey("limit"), { args: [readId], answer: { result: [0n, 10_000n, 0n] } });
  push(entries, accountKey("limitTourist"), { answer: { result: 400n } });
  push(entries, accountKey("walletProvider"), { args: [readId], answer: { result: 0n } });
  if (exists) {
    push(entries, accountKey("ownerOf"), {
      args: [readId],
      answer: { result: opts.owner ?? who },
    });
    push(entries, accountKey("getApproved"), { args: [readId], answer: { result: zeroAddress } });
  }
  for (const [key, list] of entries) {
    const repeated: CallEntry[] = [];
    for (const entry of list) {
      for (let i = 0; i < rounds; i++) {
        repeated.push(entry);
      }
    }
    entries.set(key, repeated);
  }
  return entries;
}

/** `balanceOf(owner)` on the four cash tokens (getBalances' round). */
export function balanceEntries(owner: Address, amount = 1000n): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  for (const currency of ["USD24", "EUR24", "CHF24", "CNH24"] as const) {
    push(entries, `${C.tokens[currency].proxy.toLowerCase()}:balanceOf`, {
      args: [owner],
      answer: { result: amount },
    });
  }
  return entries;
}

/** GetAllowances' ten reads: per token card-then-deposit, then USDC and F24. */
export function allowanceEntries(owner: Address, amount = 0n): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  for (const currency of ["USD24", "EUR24", "CHF24", "CNH24"] as const) {
    entries.set(`${C.tokens[currency].proxy.toLowerCase()}:allowance`, [
      { args: [owner, C.card.proxy], answer: { result: amount } },
      { args: [owner, C.deposit.proxy], answer: { result: amount } },
    ]);
  }
  push(entries, `${C.usdc.toLowerCase()}:allowance`, {
    args: [owner, C.deposit.proxy],
    answer: { result: amount },
  });
  push(entries, `${C.f24.address.toLowerCase()}:allowance`, {
    args: [owner, ACCOUNT],
    answer: { result: amount },
  });
  return entries;
}

const PAUSED_TARGETS: ReadonlyArray<Address> = [
  C.account.proxy,
  C.tokens.USD24.proxy,
  C.tokens.EUR24.proxy,
  C.tokens.CHF24.proxy,
  C.tokens.CNH24.proxy,
  C.deposit.proxy,
  C.card.proxy,
  C.f24Sales.proxy,
];

/** The getAvailability round; `paused` is per-contract, the rest shared. */
export function availabilityEntries(
  opts: {
    readonly paused?: Readonly<Record<string, boolean>> | boolean;
    readonly maxDigitForSale?: number | undefined;
  } = {},
): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  for (const target of PAUSED_TARGETS) {
    const paused =
      typeof opts.paused === "boolean"
        ? opts.paused
        : (opts.paused?.[target.toLowerCase()] ?? false);
    push(entries, `${target.toLowerCase()}:paused`, { answer: { result: paused } });
  }
  push(entries, `${C.deposit.proxy.toLowerCase()}:marketClosed`, {
    answer: { result: false },
  });
  push(entries, `${ACCOUNT.toLowerCase()}:maxDigitForSale`, {
    answer: { result: opts.maxDigitForSale ?? 6 },
  });
  return entries;
}

/** The proxyAdmin.owner read every deployment check performs. */
export function proxyAdminEntry(): Map<string, CallEntry[]> {
  return new Map([
    [`${C.proxyAdmin.address.toLowerCase()}:owner`, [{ answer: { result: C.proxyAdmin.owner } }]],
  ]);
}

const FEE_HISTORY = {
  baseFeePerGas: ["0x5f5e100", "0x5f5e100"],
  gasUsedRatio: [0.5],
  reward: [["0x1", "0x5f5e100", "0x3"]],
};

function blockPayload(number: bigint, timestamp: bigint): Record<string, unknown> {
  return {
    number: `0x${number.toString(16)}`,
    timestamp: `0x${timestamp.toString(16)}`,
    hash: ZERO_WORD,
    parentHash: ZERO_WORD,
    nonce: "0x0000000000000000",
    sha3Uncles: ZERO_WORD,
    logsBloom: `0x${"0".repeat(512)}`,
    transactionsRoot: ZERO_WORD,
    stateRoot: ZERO_WORD,
    receiptsRoot: ZERO_WORD,
    miner: `0x${"0".repeat(40)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    baseFeePerGas: "0x5f5e100",
    transactions: [],
    uncles: [],
    mixHash: ZERO_WORD,
  };
}

/* JSON-RPC `params` arrive as `unknown` — the stub asserts each method's tuple shape. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-parameters -- wire params are trusted to carry the method's shape
const param = <T>(params: unknown): T => params as T;

function sameArg(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") {
    return a === b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameArg(v, b[i]));
  }
  return a === b;
}

/** A full `eth_getTransactionByHash` payload. */
export function txPayload(args: {
  readonly hash: Hash;
  readonly from: Address;
  readonly to: Address;
  readonly input: Hex;
  readonly value: bigint;
  readonly nonce: number;
  readonly blockNumber?: bigint;
}): Record<string, unknown> {
  return {
    type: "0x0",
    hash: args.hash,
    nonce: `0x${args.nonce.toString(16)}`,
    blockHash: ZERO_WORD,
    blockNumber: `0x${(args.blockNumber ?? B).toString(16)}`,
    transactionIndex: "0x0",
    from: args.from,
    to: args.to,
    value: `0x${args.value.toString(16)}`,
    gas: "0x5208",
    gasPrice: "0x1",
    input: args.input,
    v: "0x1b",
    r: ZERO_WORD,
    s: ZERO_WORD,
  };
}

/** A raw eth_getLogs/receipt log entry. */
export function logPayload(args: {
  readonly address: Address;
  readonly topics: ReadonlyArray<Hex>;
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
  readonly logIndex?: number;
}): Record<string, unknown> {
  return {
    address: args.address,
    topics: [...args.topics],
    data: args.data,
    blockNumber: `0x${args.blockNumber.toString(16)}`,
    transactionHash: args.transactionHash,
    transactionIndex: "0x0",
    blockHash: ZERO_WORD,
    logIndex: `0x${(args.logIndex ?? 0).toString(16)}`,
    removed: false,
  };
}

const TRANSFER_TOPIC = toEventSelector(getAbiItem({ abi: tokenAbi, name: "Transfer" }));

/** `toEventSelector` for a named event — the log's `topics[0]`. */
function topic0Of(abi: Abi, name: string): Hex {
  const item = getAbiItem({ abi, name });
  if (item === undefined || item.type !== "event") {
    throw new Error(`no abi event ${name}`);
  }
  return toEventSelector(item);
}

/** `Transfer(from, to, amount)` on a cash-token proxy. */
export function transferLog(args: {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
  readonly logIndex?: number;
}): Record<string, unknown> {
  return logPayload({
    address: args.token,
    topics: [TRANSFER_TOPIC, addressTopic(args.from), addressTopic(args.to)],
    data: word(args.amount),
    blockNumber: args.blockNumber,
    transactionHash: args.transactionHash,
    logIndex: args.logIndex ?? 0,
  });
}

/** A full `eth_getTransactionReceipt` payload. */
export function receiptPayload(args: {
  readonly transactionHash: Hash;
  readonly blockNumber: bigint;
  readonly status: "success" | "reverted";
  readonly from?: Address;
  readonly to?: Address;
  readonly logs?: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    transactionHash: args.transactionHash,
    transactionIndex: "0x0",
    blockHash: ZERO_WORD,
    blockNumber: `0x${args.blockNumber.toString(16)}`,
    from: args.from ?? zeroAddress,
    to: args.to ?? zeroAddress,
    cumulativeGasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    gasUsed: "0x5208",
    contractAddress: null,
    logs: [...(args.logs ?? [])],
    logsBloom: `0x${"0".repeat(512)}`,
    status: args.status === "success" ? "0x1" : "0x0",
    type: "0x0",
  };
}

export type Fiat24Chain = {
  /** The `world({arb1})` answer source. */
  readonly arb1: Arb1Rpc;
  /** Every JSON-RPC request, in order. */
  readonly requests: RecordedRequest[];
  /** Every decoded `eth_call`, in order. */
  readonly calls: DecodedCall[];
  /** Every broadcast's raw bytes. */
  readonly sent: Hex[];
  /** Mutable — the pending/latest `eth_getTransactionCount` answers. */
  readonly count: { pending: number; latest: number };
  /** Mutable — the `eth_blockNumber` answer. */
  block: bigint;
  /**
   * Mutable — when set every `eth_blockNumber` read answers `block++` (the two-height proofs a
   * reconcile needs); corroborated reads need it off or the two endpoints desync.
   */
  autoBlock: boolean;
  /**
   * Overwrites a consumed `eth_call` answer — contract state the broadcasts changed (the new
   * allowance after a mined approve).
   */
  readonly setCall: (
    to: Address,
    functionName: string,
    args: ReadonlyArray<unknown>,
    answer: CallAnswer,
  ) => void;
  /**
   * Publishes the transaction `eth_sendRawTransaction` captured: `eth_getTransactionByHash` and
   * `eth_getTransactionReceipt` answer the payloads from the next call on.
   */
  readonly mine: (
    hash: Hash,
    opts?: {
      status?: "success" | "reverted";
      logs?: ReadonlyArray<Record<string, unknown>>;
      from?: Address;
    },
  ) => Promise<void>;
};

export function makeFiat24Chain(options: {
  readonly calls?: ReadonlyMap<string, CallEntry | ReadonlyArray<CallEntry>> | undefined;
  readonly storage?: ReadonlyMap<string, Hex> | undefined;
  readonly logs?: ((filter: Record<string, unknown>) => unknown) | undefined;
  readonly count?: { readonly pending?: number; readonly latest?: number } | undefined;
  readonly block?: bigint | undefined;
  /** Every `eth_blockNumber` read answers `block++` — the two-height proofs a reconcile needs. */
  readonly autoBlock?: boolean | undefined;
  readonly timestamp?: bigint | undefined;
  readonly receipts?: Readonly<Record<string, unknown>> | undefined;
  readonly transactions?: Readonly<Record<string, unknown>> | undefined;
}): Fiat24Chain {
  const requests: RecordedRequest[] = [];
  const calls: DecodedCall[] = [];
  const sent: Hex[] = [];
  const count = { pending: options.count?.pending ?? 0, latest: options.count?.latest ?? 0 };
  const receipts = new Map<string, unknown>();
  for (const [hash, payload] of Object.entries(options.receipts ?? {})) {
    receipts.set(hash.toLowerCase(), payload);
  }
  const transactions = new Map<string, unknown>();
  for (const [hash, payload] of Object.entries(options.transactions ?? {})) {
    transactions.set(hash.toLowerCase(), payload);
  }
  const callQueues = new Map<string, CallEntry[]>();
  for (const [key, entry] of options.calls ??
    new Map<string, CallEntry | ReadonlyArray<CallEntry>>()) {
    callQueues.set(key, "answer" in entry ? [entry] : [...entry]);
  }
  const stickyCalls: Array<{
    key: string;
    args: ReadonlyArray<unknown> | undefined;
    answer: CallAnswer;
  }> = [];
  const stub: Fiat24Chain = {
    requests,
    calls,
    sent,
    count,
    setCall: (to, functionName, args, answer) => {
      const key = `${to.toLowerCase()}:${functionName}`;
      const index = stickyCalls.findIndex(
        (sticky) => sticky.key === key && (sticky.args === undefined || sameArg(sticky.args, args)),
      );
      if (index === -1) {
        stickyCalls.push({ key, args, answer });
      } else {
        stickyCalls[index] = { key, args, answer };
      }
      /* A queued head entry for the same args must not outrank the settled state. */
      const queue = callQueues.get(key);
      if (queue !== undefined) {
        callQueues.set(
          key,
          queue.filter((entry) => !(entry.args === undefined || sameArg(entry.args, args))),
        );
      }
    },
    block: options.block ?? B,
    autoBlock: options.autoBlock === true,
    mine: async (hash, opts = {}) => {
      const mined = sent
        .map((raw) => ({ raw, hash: keccak256(raw) }))
        .find((tx) => tx.hash === hash);
      if (mined === undefined) {
        throw new Error(`no broadcast captured for ${hash}`);
      }
      const serialized = param<TransactionSerialized>(mined.raw);
      const parsed = parseTransaction(serialized);
      const from =
        opts.from ??
        (await recoverTransactionAddress({ serializedTransaction: serialized }).catch(
          () => undefined,
        )) ??
        zeroAddress;
      count.latest += 1;
      transactions.set(hash.toLowerCase(), {
        type: "0x0",
        hash,
        nonce: `0x${(parsed.nonce ?? 0).toString(16)}`,
        blockHash: ZERO_WORD,
        blockNumber: `0x${stub.block.toString(16)}`,
        transactionIndex: "0x0",
        from,
        to: parsed.to ?? zeroAddress,
        value: `0x${(parsed.value ?? 0n).toString(16)}`,
        gas: "0x5208",
        gasPrice: "0x1",
        input: parsed.data ?? "0x",
        v: "0x1b",
        r: ZERO_WORD,
        s: ZERO_WORD,
      });
      receipts.set(
        hash.toLowerCase(),
        receiptPayload({
          transactionHash: hash,
          blockNumber: stub.block,
          status: opts.status ?? "success",
          from,
          to: parsed.to ?? zeroAddress,
          logs: opts.logs ?? [],
        }),
      );
    },
    arb1: ({ method, params }) => {
      requests.push({ method, params });
      switch (method) {
        case "eth_chainId":
          return "0xa4b1";
        case "eth_blockNumber": {
          const current = stub.block;
          if (stub.autoBlock) {
            stub.block += 1n;
          }
          return `0x${current.toString(16)}`;
        }
        case "eth_getBlockByNumber": {
          const [tag] = param<[string, boolean]>(params);
          return blockPayload(
            tag === "latest" || tag === "pending" ? stub.block : BigInt(tag),
            options.timestamp ?? TIMESTAMP,
          );
        }
        case "eth_getStorageAt": {
          const [address, slot] = param<[Address, Hex, string]>(params);
          const value = options.storage?.get(`${address.toLowerCase()}:${slot.toLowerCase()}`);
          if (value === undefined) {
            throw new Error(`unexpected eth_getStorageAt ${address} ${slot}`);
          }
          return value;
        }
        case "eth_getLogs":
          return options.logs === undefined
            ? []
            : options.logs(param<Array<Record<string, unknown>>>(params)[0] ?? {});
        case "eth_getTransactionCount": {
          const [, tag] = param<[Address, string]>(params);
          return `0x${(tag === "pending" ? count.pending : count.latest).toString(16)}`;
        }
        case "eth_estimateGas":
          return "0x186a0";
        case "eth_feeHistory":
          return FEE_HISTORY;
        case "eth_gasPrice":
          return "0x5f5e100";
        case "eth_getCode":
          return "0x6000";
        case "eth_getTransactionByHash": {
          const [hash] = param<[Hash]>(params);
          return transactions.get(hash.toLowerCase()) ?? null;
        }
        case "eth_getTransactionReceipt": {
          const [hash] = param<[Hash]>(params);
          return receipts.get(hash.toLowerCase()) ?? null;
        }
        case "eth_sendRawTransaction": {
          const [raw] = param<[Hex]>(params);
          sent.push(raw);
          count.pending += 1;
          const hash = keccak256(raw);
          const pending = parseTransaction(raw);
          transactions.set(hash.toLowerCase(), {
            type: "0x0",
            hash,
            nonce: `0x${(pending.nonce ?? 0).toString(16)}`,
            blockHash: null,
            blockNumber: null,
            transactionIndex: null,
            from: zeroAddress,
            to: pending.to ?? zeroAddress,
            value: `0x${(pending.value ?? 0n).toString(16)}`,
            gas: "0x5208",
            gasPrice: "0x1",
            input: pending.data ?? "0x",
            v: "0x1b",
            r: ZERO_WORD,
            s: ZERO_WORD,
          });
          return hash;
        }
        case "eth_call": {
          const [tx, blockTag] =
            param<[{ to?: Address; data?: Hex; from?: Address; value?: Hex }, string]>(params);
          const abi = tx.to === undefined ? undefined : ABIS_BY_ADDRESS.get(tx.to.toLowerCase());
          let decoded:
            | { functionName: string; args: ReadonlyArray<unknown> | undefined }
            | undefined;
          if (abi !== undefined && tx.data !== undefined) {
            try {
              decoded = decodeFunctionData({ abi, data: tx.data });
            } catch {
              decoded = undefined;
            }
          }
          calls.push({
            to: tx.to,
            functionName: decoded?.functionName,
            args: decoded?.args,
            blockTag,
          });
          if (decoded === undefined || abi === undefined || tx.to === undefined) {
            throw new Error(`unexpected eth_call to ${String(tx.to)}`);
          }
          const key = `${tx.to.toLowerCase()}:${decoded.functionName}`;
          const queue = callQueues.get(key);
          /* Queue order stays strict; a call the queue no longer serves falls back to a
             previously consumed answer for the same args — a repeated read re-reads the
             same contract state, so it answers like a real node. */
          let answer: CallAnswer | undefined;
          /* Different-args entries are independent sub-queues: the SDK fires read rounds in
             parallel, so the first entry whose args match is consumed (FIFO per args shape). */
          const index =
            queue?.findIndex(
              (entry) => entry.args === undefined || sameArg(entry.args, decoded.args),
            ) ?? -1;
          if (queue !== undefined && index >= 0) {
            const entry = queue[index];
            if (entry !== undefined) {
              ({ answer } = entry);
              if (
                !stickyCalls.some(
                  (sticky) =>
                    sticky.key === key &&
                    (sticky.args === undefined || sameArg(sticky.args, decoded.args)),
                )
              ) {
                stickyCalls.push({ key, args: entry.args ?? decoded.args, answer });
              }
              /* Keep the last matching entry in the queue so a repeated identical call re-reads
                 the same contract state — a real node answers it the same. */
              if (
                queue.some(
                  (later, at) =>
                    at > index && (later.args === undefined || sameArg(later.args, decoded.args)),
                )
              ) {
                queue.splice(index, 1);
              }
            }
          }
          answer ??= stickyCalls.find(
            (sticky) =>
              sticky.key === key &&
              (sticky.args === undefined || sameArg(sticky.args, decoded.args)),
          )?.answer;
          if (answer === undefined) {
            throw new Error(
              `unexpected eth_call ${tx.to} ${decoded.functionName}: ${JSON.stringify(decoded.args)}`,
            );
          }
          if ("result" in answer) {
            return encodeFunctionResult({
              abi,
              functionName: decoded.functionName,
              result: answer.result,
            });
          }
          if ("raw" in answer) {
            return answer.raw;
          }
          return arb1Error(3, "execution reverted", answer.revert);
        }
        default:
          throw new Error(`unexpected arb1 call ${method}`);
      }
    },
  };
  return stub;
}

/** A EUR24 transfer's guard table per round — the SDK's transferCallTable port. */
export function transferCallTable(
  opts: {
    readonly rounds?: number;
    readonly amount?: bigint;
    readonly recipient?: Address;
    readonly sender?: Address;
    readonly balance?: bigint;
    readonly transferAnswer?: CallEntry["answer"];
    readonly allowed?: boolean;
    readonly paused?: Readonly<Record<string, boolean>> | boolean;
    readonly receiver?: PartyOpts;
    readonly senderId?: bigint;
    readonly receiverId?: bigint;
  } = {},
): Map<string, CallEntry[]> {
  const rounds = opts.rounds ?? 1;
  const amount = opts.amount ?? AMOUNT;
  const recipient = opts.recipient ?? zeroAddress;
  const sender = opts.sender ?? zeroAddress;
  const token = C.tokens.EUR24.proxy;
  const senderId = opts.senderId ?? SENDER_ID;
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    interleaveCalls(
      accountEntries(sender, { historic: senderId, rounds }),
      accountEntries(recipient, {
        historic: opts.receiverId ?? RECEIVER_ID,
        rounds,
        ...opts.receiver,
      }),
    ),
    balanceEntries(sender),
    new Map<string, CallEntry[]>([
      [
        `${token.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [sender, recipient, amount], answer: { result: opts.allowed ?? true } }],
      ],
      [`${token.toLowerCase()}:convertToChf`, [{ args: [amount], answer: { result: amount } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [senderId, amount], answer: { result: true } }],
      ],
      [
        `${token.toLowerCase()}:transfer`,
        [{ args: [recipient, amount], answer: opts.transferAnswer ?? { result: true } }],
      ],
    ]),
  );
  if (opts.balance !== undefined) {
    table.set(`${token.toLowerCase()}:balanceOf`, [
      { args: [sender], answer: { result: opts.balance } },
    ]);
  }
  return table;
}

/* ------------------------------------------------------------------------- */
/* The remaining flow tables — ported from the SDK's tests/flows/*.test.ts     */
/* (exchange / top-up / onboarding / payout / card) onto this file's helpers.  */
/* ------------------------------------------------------------------------- */

const EUR24 = C.tokens.EUR24.proxy;
const USD24 = C.tokens.USD24.proxy;
const CHF24 = C.tokens.CHF24.proxy;
const DEPOSIT = C.deposit.proxy;
const CARD = C.card.proxy;
const USDC = C.usdc;
const F24 = C.f24.address;
const F24SALES = C.f24Sales.proxy;
const PRICE_LIST = C.priceList.proxy;

/** Internal desk accounts (9100–9299) the guards resolve before each exchange/payout. */
export const TREASURY = "0x0000000000000000000000000000000000009100" as Address;
export const CRYPTO = "0x0000000000000000000000000000000000009105" as Address;
export const PAYOUT_DESK = "0x0000000000000000000000000000000000009102" as Address;

const XO_INPUT = 94n;
const XO_RATE = 9117n;
const EXCHANGE_RATE = 10_968n;
const EXCHANGE_SPREAD = 9950n;

export type ExchangeTableOpts = {
  readonly side?: "exact-in" | "exact-out";
  readonly rounds?: number;
  readonly owner?: Address;
  readonly senderId?: bigint;
  readonly amount?: bigint;
  readonly balance?: bigint;
  readonly allowance?: bigint;
  readonly totalSupply?: bigint;
  readonly rate?: bigint;
  readonly spread?: bigint;
  readonly inputAllowed?: boolean;
  readonly withinLimit?: boolean;
  readonly outputAllowed?: boolean;
  readonly statusIndex?: number;
  readonly accountBalance?: bigint;
  readonly paused?: Readonly<Record<string, boolean>>;
};

/** Every read a quoted exchange guard + approve plan + send consumes, per round. */
export function exchangeTable(opts: ExchangeTableOpts = {}): Map<string, CallEntry[]> {
  const side = opts.side ?? "exact-in";
  const rounds = opts.rounds ?? 1;
  const owner = opts.owner ?? zeroAddress;
  const senderId = opts.senderId ?? SENDER_ID;
  const amount = opts.amount ?? (side === "exact-in" ? AMOUNT : 105n);
  const input = side === "exact-in" ? amount : XO_INPUT;
  const rateToken = side === "exact-in" ? EUR24 : USD24;
  const spreadToken = side === "exact-in" ? USD24 : EUR24;
  const exactOut = side === "exact-out";
  /* The tx guards re-quote — the leg amounts come from the FRESH quote, not the stored one. */
  const freshRate = opts.rate ?? (exactOut ? XO_RATE : EXCHANGE_RATE);
  const spread = opts.spread ?? EXCHANGE_SPREAD;
  const freshResult = (((amount * freshRate) / 10_000n) * spread) / 10_000n;
  const legInput = exactOut ? freshResult : amount;
  const legOutput = exactOut ? amount : freshResult;
  const ownerOf: CallEntry[] = [];
  for (let i = 0; i < rounds; i += 1) {
    ownerOf.push(
      { args: [senderId], answer: { result: owner } },
      { args: [9100n], answer: { result: TREASURY } },
      { args: [9105n], answer: { result: CRYPTO } },
    );
  }
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    accountEntries(owner, {
      historic: senderId,
      balance: opts.accountBalance ?? 1n,
      statusIndex: opts.statusIndex ?? 5,
      rounds,
    }),
    new Map<string, CallEntry[]>([
      [
        `${DEPOSIT.toLowerCase()}:getExchangeRate`,
        [{ args: [rateToken, spreadToken], answer: { result: freshRate } }],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getSpread`,
        [{ args: [rateToken, spreadToken, exactOut], answer: { result: spread } }],
      ],
      [`${DEPOSIT.toLowerCase()}:marketClosed`, [{ answer: { result: false } }]],
      [
        `${EUR24.toLowerCase()}:balanceOf`,
        [{ args: [owner], answer: { result: opts.balance ?? 1000n } }],
      ],
      [
        `${EUR24.toLowerCase()}:allowance`,
        [{ args: [owner, DEPOSIT], answer: { result: opts.allowance ?? 0n } }],
      ],
      [
        `${EUR24.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [owner, TREASURY, legInput], answer: { result: opts.inputAllowed ?? true } }],
      ],
      [`${EUR24.toLowerCase()}:convertToChf`, [{ args: [legInput], answer: { result: legInput } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [senderId, legInput], answer: { result: opts.withinLimit ?? true } }],
      ],
      [
        `${USD24.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [CRYPTO, owner, legOutput], answer: { result: opts.outputAllowed ?? true } }],
      ],
      [`${EUR24.toLowerCase()}:approve`, [{ args: [DEPOSIT, input], answer: { result: true } }]],
      [
        `${EUR24.toLowerCase()}:totalSupply`,
        [{ answer: { result: opts.totalSupply ?? 100_000n } }],
      ],
      [
        `${DEPOSIT.toLowerCase()}:moneyExchangeExactIn`,
        [{ args: [EUR24, USD24, amount], answer: { raw: "0x" } }],
      ],
      [
        `${DEPOSIT.toLowerCase()}:moneyExchangeExactOut`,
        [{ args: [EUR24, USD24, amount], answer: { raw: "0x" } }],
      ],
    ]),
  );
  /* `accountEntries` contributes its own ownerOf entries; the desk reads must interleave exactly
     (owner first, then 9100, then 9105, per guard round). */
  table.set(`${ACCOUNT.toLowerCase()}:ownerOf`, ownerOf);
  return table;
}

export function exchangeLog(opts: {
  readonly sender: Address;
  readonly input?: bigint;
  readonly output?: bigint;
  readonly side?: "exact-in" | "exact-out";
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
}): Record<string, unknown> {
  const side = opts.side ?? "exact-in";
  const input = opts.input ?? AMOUNT;
  const output = opts.output ?? 108n;
  return logPayload({
    address: DEPOSIT,
    topics: [
      topic0Of(
        depositAbi,
        side === "exact-in" ? "MoneyExchangedExactIn" : "MoneyExchangedExactOut",
      ),
      addressTopic(opts.sender),
    ],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [EUR24, USD24, input, output],
    ),
    blockNumber: opts.blockNumber,
    transactionHash: opts.transactionHash,
  });
}

const USDC_AMOUNT = 100_000n;
const TOPUP_FEE = 1000n;
const TOPUP_MIN = 1000n;
const TOPUP_MAX = 1_000_000n;

export type TopUpTableOpts = {
  readonly rounds?: number;
  readonly owner?: Address;
  readonly senderId?: bigint;
  readonly usdcAmount?: bigint;
  readonly quotePaused?: boolean;
  readonly paused?: Readonly<Record<string, boolean>>;
  readonly usdcBalance?: bigint;
  readonly usdcAllowance?: bigint;
  readonly totalSupply?: bigint;
  readonly outputAllowed?: boolean;
  readonly rate?: bigint;
  readonly spread?: bigint;
  readonly usdcRate?: bigint;
  readonly fee?: bigint;
  readonly min?: bigint;
  readonly max?: bigint;
  readonly output?: Currency24;
};

type Currency24 = "EUR24" | "USD24" | "CHF24" | "CNH24";

/** Every read the top-up check/quoted guards + approve plan + send consume, per round. */
export function topUpTable(opts: TopUpTableOpts = {}): Map<string, CallEntry[]> {
  const rounds = opts.rounds ?? 1;
  const owner = opts.owner ?? zeroAddress;
  const senderId = opts.senderId ?? SENDER_ID;
  const usdcAmount = opts.usdcAmount ?? USDC_AMOUNT;
  const rate = opts.rate ?? EXCHANGE_RATE;
  const spread = opts.spread ?? EXCHANGE_SPREAD;
  const usdcRate = opts.usdcRate ?? 10_000n;
  const fee = opts.fee ?? TOPUP_FEE;
  const outputToken = C.tokens[opts.output ?? "EUR24"].proxy;
  /* Fixture quote: o=(usdc-fee)/1e4*usdcRate/1e4; output=floor(o*rate/1e4*spread/1e4). */
  const o = (((usdcAmount - fee) / 10_000n) * usdcRate) / 10_000n;
  const legOutput = (((o * rate) / 10_000n) * spread) / 10_000n;
  const ownerOf: CallEntry[] = [];
  const depositPausedQueue: CallEntry[] = [];
  const depositAvailPaused = opts.paused?.[DEPOSIT.toLowerCase()] ?? false;
  for (let i = 0; i < rounds; i += 1) {
    ownerOf.push({ args: [9105n], answer: { result: CRYPTO } });
    /* `paused()` is read once by getTopUpQuote and again inside getAvailability —
       same key, served in that order each round. */
    depositPausedQueue.push(
      { answer: { result: opts.quotePaused ?? false } },
      { answer: { result: depositAvailPaused } },
    );
  }
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    new Map<string, CallEntry[]>([
      [
        `${DEPOSIT.toLowerCase()}:minUsdcDepositAmount`,
        [{ answer: { result: opts.min ?? TOPUP_MIN } }],
      ],
      [
        `${DEPOSIT.toLowerCase()}:maxUsdcDepositAmount`,
        [{ answer: { result: opts.max ?? TOPUP_MAX } }],
      ],
      [
        `${ACCOUNT.toLowerCase()}:historicOwnership`,
        [{ args: [owner], answer: { result: senderId } }],
      ],
      [
        `${DEPOSIT.toLowerCase()}:exchangeRates`,
        [{ args: [USDC, USD24], answer: { result: usdcRate } }],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getExchangeRate`,
        [
          {
            args: [USD24, opts.output === "USD24" ? EUR24 : outputToken],
            answer: { result: rate },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getSpread`,
        [
          {
            args: [USD24, opts.output === "USD24" ? EUR24 : outputToken, false],
            answer: { result: spread },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getFee`,
        [{ args: [senderId, usdcAmount], answer: { result: fee } }],
      ],
      [
        `${USDC.toLowerCase()}:balanceOf`,
        [{ args: [owner], answer: { result: opts.usdcBalance ?? usdcAmount } }],
      ],
      [
        `${USDC.toLowerCase()}:allowance`,
        [{ args: [owner, DEPOSIT], answer: { result: opts.usdcAllowance ?? 0n } }],
      ],
      [
        `${USDC.toLowerCase()}:totalSupply`,
        [{ answer: { result: opts.totalSupply ?? 100_000_000n } }],
      ],
      [
        `${outputToken.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [CRYPTO, owner, legOutput], answer: { result: opts.outputAllowed ?? true } }],
      ],
      [
        `${USDC.toLowerCase()}:approve`,
        [{ args: [DEPOSIT, usdcAmount], answer: { result: true } }],
      ],
      [
        `${DEPOSIT.toLowerCase()}:depositTokenViaUsdc`,
        [{ args: [USDC, outputToken, usdcAmount], answer: { raw: "0x" } }],
      ],
      [`${ACCOUNT.toLowerCase()}:ownerOf`, ownerOf],
    ]),
  );
  table.set(`${DEPOSIT.toLowerCase()}:paused`, depositPausedQueue);
  return table;
}

export function topUpLog(opts: {
  readonly sender: Address;
  readonly input?: bigint;
  readonly output?: bigint;
  readonly outputToken?: Address;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
}): Record<string, unknown> {
  return logPayload({
    address: DEPOSIT,
    topics: [topic0Of(depositAbi, "DepositedTokenViaUsd"), addressTopic(opts.sender)],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [USDC, opts.outputToken ?? EUR24, opts.input ?? USDC_AMOUNT, opts.output ?? 8n],
    ),
    blockNumber: opts.blockNumber,
    transactionHash: opts.transactionHash,
  });
}

const PRICE_F24 = 20_000n;
const QUOTE_PER_ETHER = 10_000n;

export type OnboardingTableOpts = {
  readonly owner?: Address;
  readonly tokenId?: bigint;
  readonly paused?: Readonly<Record<string, boolean>>;
  readonly maxDigitForSale?: number;
  readonly historic?: bigint;
  readonly nftBalance?: bigint;
  readonly taken?: boolean;
  readonly priceF24?: bigint;
  readonly quotePerEther?: bigint;
  readonly f24Balance?: bigint;
  readonly f24Allowance?: bigint;
  readonly f24Supply?: bigint;
};

/** Every read the onboarding check guards + plan + send consume. */
export function onboardingTable(opts: OnboardingTableOpts = {}): Map<string, CallEntry[]> {
  const owner = opts.owner ?? zeroAddress;
  const tokenId = opts.tokenId ?? SENDER_ID;
  return mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false, maxDigitForSale: opts.maxDigitForSale }),
    new Map<string, CallEntry[]>([
      [
        `${ACCOUNT.toLowerCase()}:historicOwnership`,
        [{ args: [owner], answer: { result: opts.historic ?? 0n } }],
      ],
      [
        `${ACCOUNT.toLowerCase()}:balanceOf`,
        [{ args: [owner], answer: { result: opts.nftBalance ?? 0n } }],
      ],
      [
        `${ACCOUNT.toLowerCase()}:exists`,
        [{ args: [tokenId], answer: { result: opts.taken ?? false } }],
      ],
      [
        `${PRICE_LIST.toLowerCase()}:getPrice`,
        [{ args: [tokenId], answer: { result: opts.priceF24 ?? PRICE_F24 } }],
      ],
      [
        `${F24SALES.toLowerCase()}:quotePerEther`,
        [{ answer: { result: opts.quotePerEther ?? QUOTE_PER_ETHER } }],
      ],
      [
        `${F24.toLowerCase()}:balanceOf`,
        [{ args: [owner], answer: { result: opts.f24Balance ?? PRICE_F24 } }],
      ],
      [
        `${F24.toLowerCase()}:allowance`,
        [{ args: [owner, ACCOUNT], answer: { result: opts.f24Allowance ?? 0n } }],
      ],
      [`${F24.toLowerCase()}:totalSupply`, [{ answer: { result: opts.f24Supply ?? 1_000_000n } }]],
      [
        `${F24.toLowerCase()}:approve`,
        [{ args: [ACCOUNT, opts.priceF24 ?? PRICE_F24], answer: { result: true } }],
      ],
      [`${ACCOUNT.toLowerCase()}:mintByClient`, [{ args: [tokenId], answer: { raw: "0x" } }]],
      [
        `${ACCOUNT.toLowerCase()}:mintByClientWithETH`,
        [{ args: [tokenId], answer: { raw: "0x" } }],
      ],
    ]),
  );
}

/** The getAccount({tokenId}) round the tourist/kyc poll consumes per advance. */
export function accountByIdEntries(
  opts: { readonly tokenId?: bigint; readonly owner?: Address; readonly statusIndex?: number } = {},
): Map<string, CallEntry[]> {
  const tokenId = opts.tokenId ?? SENDER_ID;
  return new Map<string, CallEntry[]>([
    [`${ACCOUNT.toLowerCase()}:exists`, [{ args: [tokenId], answer: { result: true } }]],
    [
      `${ACCOUNT.toLowerCase()}:status`,
      [{ args: [tokenId], answer: { result: opts.statusIndex ?? 2 } }],
    ],
    [
      `${ACCOUNT.toLowerCase()}:limit`,
      [{ args: [tokenId], answer: { result: [0n, 10_000n, 0n] } }],
    ],
    [`${ACCOUNT.toLowerCase()}:limitTourist`, [{ answer: { result: 400n } }]],
    [`${ACCOUNT.toLowerCase()}:walletProvider`, [{ args: [tokenId], answer: { result: 0n } }]],
    [
      `${ACCOUNT.toLowerCase()}:ownerOf`,
      [{ args: [tokenId], answer: { result: opts.owner ?? zeroAddress } }],
    ],
    [
      `${ACCOUNT.toLowerCase()}:getApproved`,
      [{ args: [tokenId], answer: { result: zeroAddress } }],
    ],
  ]);
}

export function mintLog(opts: {
  readonly from: Address;
  readonly to: Address;
  readonly tokenId: bigint;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
}): Record<string, unknown> {
  return logPayload({
    address: ACCOUNT,
    topics: [
      topic0Of(accountAbi, "Transfer"),
      addressTopic(opts.from),
      addressTopic(opts.to),
      word(opts.tokenId),
    ],
    data: "0x",
    blockNumber: opts.blockNumber,
    transactionHash: opts.transactionHash,
  });
}

export type PayoutTableOpts = {
  readonly currency?: "EUR24" | "CHF24";
  readonly amount?: bigint;
  readonly owner?: Address;
  readonly tokenId?: bigint;
  readonly contactId?: string;
  readonly purposeId?: bigint;
  readonly ref?: string;
  readonly balance?: bigint;
  readonly minimum?: bigint;
  readonly allowed?: boolean;
  readonly withinLimit?: boolean;
  readonly statusIndex?: number;
  readonly tokenOwner?: Address;
  readonly paused?: Readonly<Record<string, boolean>>;
};

/** Every read the payout main guard + simulate consumes for one ready round. */
export function payoutTable(opts: PayoutTableOpts = {}): Map<string, CallEntry[]> {
  const token = (opts.currency === "CHF24" ? CHF24 : EUR24).toLowerCase();
  const amount = opts.amount ?? AMOUNT;
  const owner = opts.owner ?? zeroAddress;
  const tokenId = opts.tokenId ?? SENDER_ID;
  const contactId = opts.contactId ?? "EA-123456";
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    accountEntries(owner, {
      historic: tokenId,
      statusIndex: opts.statusIndex ?? 5,
      ...(opts.tokenOwner === undefined ? {} : { owner: opts.tokenOwner }),
    }),
    new Map<string, CallEntry[]>([
      [`${token}:minimalPayoutAmount`, [{ answer: { result: opts.minimum ?? 5n } }]],
      [`${token}:balanceOf`, [{ args: [owner], answer: { result: opts.balance ?? 1000n } }]],
      [
        `${token}:tokenTransferAllowed`,
        [{ args: [owner, PAYOUT_DESK, amount], answer: { result: opts.allowed ?? true } }],
      ],
      [`${token}:convertToChf`, [{ args: [amount], answer: { result: amount } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [tokenId, amount], answer: { result: opts.withinLimit ?? true } }],
      ],
      [`${token}:clientPayout`, [{ args: [amount, contactId], answer: { raw: "0x" } }]],
      [
        `${token}:clientPayoutRef`,
        [
          {
            args: [amount, contactId, opts.purposeId ?? 2n, opts.ref ?? "ref"],
            answer: { raw: "0x" },
          },
        ],
      ],
    ]),
  );
  /* ownerOf order per guard round: senderLive's tokenId first, then the 9102 desk. */
  table.set(`${ACCOUNT.toLowerCase()}:ownerOf`, [
    { args: [tokenId], answer: { result: opts.tokenOwner ?? owner } },
    { args: [9102n], answer: { result: PAYOUT_DESK } },
  ]);
  return table;
}

export function payoutLog(opts: {
  readonly token?: Address;
  readonly ref?: string;
  readonly tokenId?: bigint;
  readonly amount?: bigint;
  readonly contactId?: string;
  readonly purposeId?: bigint;
  readonly sender?: Address;
  readonly txid?: string;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
}): Record<string, unknown> {
  const withRef = opts.ref !== undefined;
  return logPayload({
    address: opts.token ?? EUR24,
    topics: [
      topic0Of(tokenAbi, withRef ? "ClientPayoutRef" : "ClientPayout"),
      word(opts.tokenId ?? 9102n),
      addressTopic(opts.sender ?? zeroAddress),
    ],
    data: encodeAbiParameters(
      withRef
        ? [
            { type: "uint256" },
            { type: "uint256" },
            { type: "string" },
            { type: "string" },
            { type: "uint256" },
            { type: "string" },
          ]
        : [{ type: "uint256" }, { type: "uint256" }, { type: "string" }, { type: "string" }],
      withRef
        ? [
            9102n,
            opts.amount ?? AMOUNT,
            opts.contactId ?? "EA-123456",
            opts.txid ?? "pacs.008.001.01-abc",
            opts.purposeId ?? 2n,
            opts.ref,
          ]
        : [
            9102n,
            opts.amount ?? AMOUNT,
            opts.contactId ?? "EA-123456",
            opts.txid ?? "pacs.008.001.01-abc",
          ],
    ),
    blockNumber: opts.blockNumber,
    transactionHash: opts.transactionHash,
  });
}

export type CardTableOpts = {
  readonly currency?: Currency24;
  readonly amount?: bigint;
  readonly owner?: Address;
  readonly tokenId?: bigint;
  readonly allowance?: bigint;
  readonly totalSupply?: bigint;
  readonly paused?: Readonly<Record<string, boolean>>;
};

/** The card-setup cap round — the card operation itself is API-side, no chain calls. */
export function cardTable(opts: CardTableOpts = {}): Map<string, CallEntry[]> {
  const token = (opts.currency === "USD24" ? USD24 : EUR24).toLowerCase();
  const amount = opts.amount ?? 100n;
  const owner = opts.owner ?? zeroAddress;
  return mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    accountEntries(owner, { historic: opts.tokenId ?? SENDER_ID }),
    new Map<string, CallEntry[]>([
      [`${token}:allowance`, [{ args: [owner, CARD], answer: { result: opts.allowance ?? 0n } }]],
      [`${token}:totalSupply`, [{ answer: { result: opts.totalSupply ?? 10_000_000n } }]],
      [`${token}:approve`, [{ args: [CARD, amount], answer: { result: true } }]],
    ]),
  );
}

/** `Approval(owner, spender, amount)` on a cash-token/F24/USDC contract. */
export function approveLog(args: {
  readonly token: Address;
  readonly owner: Address;
  readonly spender: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
}): Record<string, unknown> {
  return logPayload({
    address: args.token,
    topics: [topic0Of(tokenAbi, "Approval"), addressTopic(args.owner), addressTopic(args.spender)],
    data: word(args.amount),
    blockNumber: args.blockNumber,
    transactionHash: args.transactionHash,
  });
}
