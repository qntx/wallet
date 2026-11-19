import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import * as z from "zod/mini";

import { PROGRAM_IDS, solanaTokenTable } from "@qntx/wallet-chains/solana";

import type { SolanaRpc } from "../networks/controller.ts";
import { OrderedMerge } from "./merge.ts";
import type { Stream } from "./merge.ts";
import type { HistoryChange, HistoryEntry, HistoryFlag } from "./types.ts";

const SIG_PAGE = 25;
const TOKEN_ACCOUNTS_MAX = 10;
const TX_CONCURRENCY = 4;

const signatureInfo = z.looseObject({
  signature: z.string(),
  slot: z.int(),
  blockTime: z.union([z.int(), z.null()]),
});

const signatureList = z.array(signatureInfo);

const uiTokenAmount = z.looseObject({ amount: z.string(), decimals: z.int() });
const tokenBalance = z.looseObject({
  accountIndex: z.int(),
  mint: z.string(),
  owner: z.optional(z.string()),
  uiTokenAmount,
});

const parsedInfo = z.looseObject({ type: z.optional(z.string()) });
const instruction = z.looseObject({
  program: z.optional(z.string()),
  programId: z.optional(z.string()),
  parsed: z.optional(z.union([parsedInfo, z.string()])),
});

const parsedTx = z.looseObject({
  slot: z.optional(z.int()),
  blockTime: z.optional(z.union([z.int(), z.null()])),
  meta: z.union([
    z.looseObject({
      err: z.optional(z.unknown()),
      fee: z.int(),
      preBalances: z.array(z.number()),
      postBalances: z.array(z.number()),
      preTokenBalances: z.array(tokenBalance),
      postTokenBalances: z.array(tokenBalance),
      innerInstructions: z.array(z.looseObject({ instructions: z.array(instruction) })),
    }),
    z.null(),
  ]),
  transaction: z.looseObject({
    message: z.looseObject({
      accountKeys: z.array(z.looseObject({ pubkey: z.string() })),
      instructions: z.array(instruction),
    }),
  }),
});

export type SolanaSignatureInfo = z.output<typeof signatureInfo>;
export type SolanaParsedTx = z.output<typeof parsedTx>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `run` over `items`, at most `n` in flight, order preserved. */
const mapPool = async <T, R>(
  items: ReadonlyArray<T>,
  n: number,
  run: (t: T) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
  const out: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        // The cursor bounds it: current < items.length.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const item = items[current] as T;
        // oxlint-disable-next-line eslint/no-await-in-loop -- the shared cursor serializes each worker's steps.
        out[current] = await run(item);
      }
    }),
  );
  return out;
};

const keyOf = (info: SolanaSignatureInfo): number =>
  info.blockTime === null ? Number.MAX_SAFE_INTEGER : info.blockTime * 1000;

/** `getSignaturesForAddress` paged by `before` until a short page says there is no more. */
const signatureStream = (rpc: SolanaRpc, account: string): Stream<SolanaSignatureInfo> => {
  let before: string | undefined;
  let done = false;
  return {
    id: account,
    next: async () => {
      if (done) {
        return { items: [], done: true };
      }
      const result = z.safeParse(
        signatureList,
        await rpc.call("getSignaturesForAddress", [
          account,
          { limit: SIG_PAGE, ...(before === undefined ? {} : { before }) },
        ]),
      );
      if (!result.success) {
        throw new Error(`getSignaturesForAddress ${account}: malformed response`);
      }
      const page = result.data;
      done = page.length < SIG_PAGE;
      before = page.at(-1)?.signature;
      return { items: page, done };
    },
  };
};

type TokenAccount = { readonly pubkey: string; readonly mint: string; readonly amount: bigint };

/** Up to TOKEN_ACCOUNTS_MAX of the owner's token accounts: listed mints first, then size. */
const tokenAccounts = async (rpc: SolanaRpc, network: string, owner: string) => {
  const accounts: TokenAccount[] = [];
  await Promise.all(
    [TOKEN_PROGRAM_ADDRESS, PROGRAM_IDS.token2022].map(async (programId) => {
      const response = await rpc.call("getTokenAccountsByOwner", [
        owner,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      const value = isObject(response) ? response["value"] : undefined;
      const list: unknown[] = Array.isArray(value) ? value : [];
      for (const entry of list) {
        if (!isObject(entry)) {
          continue;
        }
        const { account } = entry;
        if (!isObject(account) || account["owner"] !== programId) {
          continue;
        }
        const { data } = account;
        const info =
          isObject(data) && isObject(data["parsed"]) ? data["parsed"]["info"] : undefined;
        const tokenAmount = isObject(info) ? info["tokenAmount"] : undefined;
        const amount =
          isObject(tokenAmount) && typeof tokenAmount["amount"] === "string"
            ? tokenAmount["amount"]
            : undefined;
        const { pubkey } = entry;
        if (
          !isObject(info) ||
          info["owner"] !== owner ||
          typeof info["mint"] !== "string" ||
          amount === undefined ||
          !/^\d+$/.test(amount) ||
          typeof pubkey !== "string"
        ) {
          continue;
        }
        accounts.push({ pubkey, mint: info["mint"], amount: BigInt(amount) });
      }
    }),
  );
  const listed = solanaTokenTable[network] ?? {};
  return [...accounts]
    .sort((a, b) => {
      const listedDiff = Number(b.mint in listed) - Number(a.mint in listed);
      if (listedDiff !== 0) {
        return listedDiff;
      }
      if (a.amount !== b.amount) {
        return a.amount < b.amount ? 1 : -1;
      }
      return a.pubkey < b.pubkey ? -1 : 1;
    })
    .slice(0, TOKEN_ACCOUNTS_MAX);
};

/** Every parsed instruction of the transaction — outer plus inner — for transfer scanning. */
const instructionsOf = (tx: SolanaParsedTx) => {
  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((bundle) => bundle.instructions);
  return [...outer, ...inner];
};

const infoField = (ix: SolanaParsedTx["transaction"]["message"]["instructions"][number]) => {
  const { parsed } = ix;
  if (parsed === undefined || typeof parsed === "string" || !isObject(parsed["info"])) {
    return undefined;
  }
  return { program: ix.program, type: parsed.type, info: parsed["info"] };
};

const transferAmount = (info: Record<string, unknown>): string | undefined => {
  const { tokenAmount } = info;
  if (isObject(tokenAmount) && typeof tokenAmount["amount"] === "string") {
    return tokenAmount["amount"];
  }
  return str(info["amount"]);
};

const lamportsField = (raw: unknown): bigint | undefined => {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) {
    return BigInt(raw);
  }
  return typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : undefined;
};

/**
 * Lamports moved by the parsed system instructions touching `owner` — transfers and account
 * creations, outer and inner, summed exactly. Used when the balances themselves are beyond `Number`
 * precision and their delta cannot be trusted.
 */
const lamportFlows = (tx: SolanaParsedTx, owner: string): bigint => {
  let net = 0n;
  for (const ix of instructionsOf(tx)) {
    const field = infoField(ix);
    if (field === undefined || field.program !== "system") {
      continue;
    }
    const amount = lamportsField(field.info["lamports"]);
    if (amount === undefined) {
      continue;
    }
    if (field.type === "transfer" || field.type === "transferWithSeed") {
      if (str(field.info["source"]) === owner) {
        net -= amount;
      }
      if (str(field.info["destination"]) === owner) {
        net += amount;
      }
    } else if (field.type === "createAccount" || field.type === "createAccountWithSeed") {
      if (str(field.info["source"]) === owner) {
        net -= amount;
      }
      if (str(field.info["newAccount"]) === owner) {
        net += amount;
      }
    }
  }
  return net;
};

/**
 * The group's view of one confirmed-or-failed Solana transaction — read from the ledger itself, so
 * `verified` is true when the read went to a host endpoint (`trusted`) and the owner's balances
 * fit `Number` precision; a gateway-first read or a rounded lamport delta stays unverified.
 * Balance deltas (lamports plus per-mint token balances owned by the owner) become the changes;
 * counterparties come from the parsed transfer instructions, resolved through the token-balance
 * owners so a token account maps back to the wallet behind it.
 */
export const solanaEntry = (
  network: string,
  owner: string,
  sigInfo: SolanaSignatureInfo,
  tx: SolanaParsedTx,
  trusted: boolean,
): HistoryEntry => {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const ownerIndex = keys.indexOf(owner);
  const [payer] = keys;
  const fee = payer === owner && tx.meta !== null ? String(tx.meta.fee) : undefined;
  const { meta } = tx;

  // token-account pubkey → {owner, mint}, from the transaction's own balance records.
  const tokenMeta = new Map<string, { readonly owner?: string; readonly mint: string }>();
  for (const balance of [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])]) {
    const pubkey = keys[balance.accountIndex];
    if (pubkey !== undefined) {
      tokenMeta.set(pubkey, {
        ...(balance.owner === undefined ? {} : { owner: balance.owner }),
        mint: balance.mint,
      });
    }
  }

  const changes: HistoryChange[] = [];
  const flags = new Set<HistoryFlag>();
  let verified = trusted;
  if (meta !== null && ownerIndex !== -1) {
    const pre = meta.preBalances[ownerIndex] ?? 0;
    const post = meta.postBalances[ownerIndex] ?? 0;
    let net: bigint;
    if (Number.isSafeInteger(pre) && Number.isSafeInteger(post)) {
      net = BigInt(post) - BigInt(pre) + (fee === undefined ? 0n : BigInt(fee));
    } else {
      // Past 2^53 the parsed balances are rounded doubles — take the lamport flow from the
      // system instructions instead; the read is not exact, so the entry stays unverified.
      verified = false;
      net = lamportFlows(tx, owner);
    }
    if (net !== 0n) {
      changes.push({
        direction: net > 0n ? "in" : "out",
        asset: "lamports",
        amount: (net < 0n ? -net : net).toString(10),
        decimals: 9,
        symbol: "SOL",
        listed: true,
      });
    }
  }
  if (meta !== null) {
    // Token deltas key off the balance's owner, not accountKeys — an incoming SPL transfer can
    // credit the wallet without the owner ever appearing as an account.
    const deltas = new Map<string, { delta: bigint; decimals: number }>();
    for (const balance of [...meta.preTokenBalances, ...meta.postTokenBalances]) {
      if (balance.owner !== owner) {
        continue;
      }
      const sign = meta.postTokenBalances.includes(balance) ? 1n : -1n;
      const current = deltas.get(balance.mint) ?? { delta: 0n, decimals: 0 };
      deltas.set(balance.mint, {
        delta: current.delta + sign * BigInt(balance.uiTokenAmount.amount),
        decimals: balance.uiTokenAmount.decimals,
      });
    }
    for (const [mint, { delta, decimals }] of deltas) {
      if (delta === 0n) {
        continue;
      }
      const known = solanaTokenTable[network]?.[mint];
      changes.push({
        direction: delta > 0n ? "in" : "out",
        asset: mint,
        amount: (delta < 0n ? -delta : delta).toString(10),
        decimals: known?.decimals ?? decimals,
        ...(known === undefined ? {} : { symbol: known.symbol }),
        listed: known !== undefined,
      });
    }
  }

  const counterparties = new Set<string>();
  const ourSide = (account: string | undefined): boolean =>
    account === owner || (account !== undefined && tokenMeta.get(account)?.owner === owner);
  for (const ix of instructionsOf(tx)) {
    const field = infoField(ix);
    if (field === undefined) {
      continue;
    }
    const { program, type, info } = field;
    if (program === "system" && (type === "transfer" || type === "transferWithSeed")) {
      const source = str(info["source"]);
      const destination = str(info["destination"]);
      if (source === owner && destination !== undefined) {
        counterparties.add(destination);
      } else if (destination === owner && source !== undefined) {
        counterparties.add(source);
      }
      continue;
    }
    if (program === "spl-token" && (type === "transfer" || type === "transferChecked")) {
      const source = str(info["source"]);
      const destination = str(info["destination"]);
      const authority = str(info["authority"]);
      const sourceOurs = ourSide(source) || authority === owner;
      const destinationOurs = ourSide(destination);
      const mint =
        str(info["mint"]) ??
        (sourceOurs ? tokenMeta.get(source ?? "")?.mint : tokenMeta.get(destination ?? "")?.mint);
      const amount = transferAmount(info);
      if (sourceOurs === destinationOurs) {
        continue;
      }
      const other = sourceOurs ? destination : source;
      if (other !== undefined) {
        counterparties.add(tokenMeta.get(other)?.owner ?? other);
      }
      if (
        amount === "0" &&
        mint !== undefined &&
        !changes.some((change) => change.asset === mint)
      ) {
        // A zero-value token touch leaves no delta but is still a visible poke (poisoning shape).
        const tokenAmount = isObject(info["tokenAmount"]) ? info["tokenAmount"] : undefined;
        const decimals =
          tokenAmount !== undefined && typeof tokenAmount["decimals"] === "number"
            ? tokenAmount["decimals"]
            : undefined;
        const known = solanaTokenTable[network]?.[mint];
        changes.push({
          direction: sourceOurs ? "out" : "in",
          asset: mint,
          amount: "0",
          ...(decimals === undefined ? {} : { decimals }),
          ...(known === undefined ? {} : { symbol: known.symbol }),
          listed: known !== undefined,
        });
        flags.add("zero-value-transfer");
      }
    }
  }
  if (changes.some((change) => change.amount === "0")) {
    flags.add("zero-value-transfer");
  }
  const ins = changes.some((c) => c.direction === "in");
  const outs = changes.some((c) => c.direction === "out");
  const blockTime = tx.blockTime ?? sigInfo.blockTime;
  return {
    id: `${network}:${sigInfo.signature}`,
    family: "solana",
    network,
    hash: sigInfo.signature,
    direction: ins && outs ? "mixed" : ins ? "in" : outs ? "out" : "self",
    counterparties: [...counterparties].filter((c) => c !== owner).slice(0, 100),
    changes: changes.slice(0, 100),
    ...(fee === undefined ? {} : { fee }),
    status: meta !== null && meta.err === null ? "confirmed" : "failed",
    ...(blockTime === null || blockTime === undefined ? {} : { timestamp: blockTime * 1000 }),
    block: tx.slot ?? sigInfo.slot,
    verified,
    origin: "chain",
    flags: [...flags],
  };
};

/**
 * One history stream for an enabled Solana network: the owner's signature pages merged with those
 * of its biggest token accounts (an incoming SPL transfer may never name the owner in
 * `accountKeys`), each signature resolved through `getTransaction`. `trusted` is false when the
 * only reachable endpoint is the gateway — entries then stay unverified.
 */
export const solanaHistoryStream = (
  options: {
    readonly rpc: SolanaRpc;
    readonly network: string;
    readonly owner: string;
    readonly trusted: boolean;
  },
  onError: (streamId: string, error: unknown) => void,
): Stream<HistoryEntry> => {
  const { rpc, network, owner, trusted } = options;
  let merge: OrderedMerge<SolanaSignatureInfo> | undefined;
  const inner = async (): Promise<OrderedMerge<SolanaSignatureInfo>> => {
    if (merge === undefined) {
      const accounts = await tokenAccounts(rpc, network, owner);
      merge = new OrderedMerge(
        [signatureStream(rpc, owner), ...accounts.map((a) => signatureStream(rpc, a.pubkey))],
        keyOf,
        (info) => info.signature,
        // The token-account sub-streams are this one source's internals — errors name the network.
        (_account, error) => onError(network, error),
      );
    }
    return merge;
  };
  let done = false;
  return {
    id: network,
    next: async () => {
      if (done) {
        return { items: [], done: true };
      }
      const merged = await inner();
      const page = await merged.take(SIG_PAGE);
      const entries = await mapPool(page.items, TX_CONCURRENCY, async (sigInfo) => {
        const result = z.safeParse(
          parsedTx,
          await rpc.call("getTransaction", [
            sigInfo.signature,
            {
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            },
          ]),
        );
        return result.success && result.data.meta !== null
          ? solanaEntry(network, owner, sigInfo, result.data, trusted)
          : undefined;
      });
      ({ done } = page);
      return { items: entries.filter((e) => e !== undefined), done };
    },
  };
};
