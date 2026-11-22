/* oxlint-disable typescript/no-unsafe-type-assertion -- RPC and JSON oracle payloads are untyped */
import { writeFileSync } from "node:fs";

/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/fiat24-mainnet.json: real Arbitrum One transactions that call the
 * pinned Fiat24 proxies — the mainnet corpus the decoder tests replay.
 *
 * Event windows are seeded from ~/Desktop/qntx/fiat24-audit/spec/evidence/onchain/event-samples.txt
 * (read-only; the recorded blocks where each event last fired) and searched with eth_getLogs in
 * windows of at most 10000 blocks — Arbitrum endpoints return wrong results on wide windows.
 * Requests are sequential and throttled; the Tenderly archive endpoint is tried first and the
 * BlastAPI archive is the fallback. tx
 * 0xbe87afca37b50fc68a3dd9ea5b18c6377b50f7491085f3989c6f04131439dea3 is always included. At most
 * three transactions are kept per (contract, selector); selectors with no mainnet sample are listed
 * in `missingSelectors`.
 *
 * Run from the repo root: bun scripts/vectors/fiat24-mainnet.ts
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const OUT = "vectors/chains/fiat24-mainnet.json";
const RPCS = ["https://arbitrum.gateway.tenderly.co", "https://arbitrum-one.public.blastapi.io"];

const USD24 = "0xbE00f3db78688d9704BCb4e0a827aea3a9Cc0D62";
const EUR24 = "0x2c5d06f591D0d8cd43Ac232c2B654475a142c7DA";
const CHF24 = "0xd41F1f0cf89fD239ca4c1F8E8ADA46345c86b0a4";
const CNH24 = "0x7288Ac74d211735374A23707D1518DCbbc0144fd";
const ACCOUNT = "0x133CAEecA096cA54889db71956c7f75862Ead7A0";
const DEPOSIT = "0x4582f67698843Dfb6A9F195C0dDee05B0A8C973F";
const CARD = "0xe2e3B88B9893e18D0867c08f9cA93f8aB5935b14";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const PROXIES = new Set(
  [USD24, EUR24, CHF24, CNH24, ACCOUNT, DEPOSIT, CARD].map((a) => a.toLowerCase()),
);
const REQUIRED_TX = "0xbe87afca37b50fc68a3dd9ea5b18c6377b50f7491085f3989c6f04131439dea3";

const topic0 = (sig: string): string => `0x${bytesToHex(keccak_256(utf8ToBytes(sig)))}`;
const pad32 = (addr: string): string => `0x${addr.replace(/^0x/, "").padStart(64, "0")}`;

const T = {
  Transfer: topic0("Transfer(address,address,uint256)"),
  Approval: topic0("Approval(address,address,uint256)"),
  ClientPayout: topic0("ClientPayout(uint256,address,uint256,uint256,string,string)"),
  ClientPayoutRef: topic0(
    "ClientPayoutRef(uint256,address,uint256,uint256,string,string,uint256,string)",
  ),
  MoneyExchangedExactIn: topic0("MoneyExchangedExactIn(address,address,address,uint256,uint256)"),
  MoneyExchangedExactOut: topic0("MoneyExchangedExactOut(address,address,address,uint256,uint256)"),
  DepositedTokenViaUsd: topic0("DepositedTokenViaUsd(address,address,address,uint256,uint256)"),
  DepositedEth: topic0("DepositedEth(address,address,address,uint256,uint256)"),
  DepositedTokenViaEth: topic0("DepositedTokenViaEth(address,address,address,uint256,uint256)"),
};

/* [contract, topics, seed block] — seeds are the recorded last-seen blocks in
   event-samples.txt; each search covers seed..seed+9999 to catch the three most recent calls. */
const SEARCHES: ReadonlyArray<readonly [string, ReadonlyArray<string | undefined>, number]> = [
  [EUR24, [T.ClientPayout], 526291731],
  [EUR24, [T.ClientPayoutRef], 526312074],
  [CHF24, [T.ClientPayoutRef], 525268686],
  [DEPOSIT, [T.MoneyExchangedExactIn], 526310471],
  [DEPOSIT, [T.MoneyExchangedExactOut], 526328805],
  [DEPOSIT, [T.DepositedTokenViaUsd], 483887108],
  [DEPOSIT, [T.DepositedEth], 483862343],
  [DEPOSIT, [T.DepositedTokenViaEth], 483685683],
  [ACCOUNT, [T.Transfer], 526354867],
  [
    ACCOUNT,
    [T.Transfer, "0x0000000000000000000000000000000000000000000000000000000000000000"],
    526354867,
  ],
  [EUR24, [T.Transfer], 526365338],
  [USD24, [T.Transfer], 526365338],
  [CHF24, [T.Transfer], 526365338],
  [EUR24, [T.Approval, undefined, pad32(DEPOSIT)], 526365338],
  [USD24, [T.Approval, undefined, pad32(DEPOSIT)], 526365338],
  [EUR24, [T.Approval, undefined, pad32(CARD)], 526365338],
  [USD24, [T.Approval, undefined, pad32(CARD)], 526365338],
  [USDC, [T.Approval, undefined, pad32(DEPOSIT)], 483887108],
];

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const rpc = async (method: string, params: ReadonlyArray<unknown>): Promise<unknown> => {
  let last: Error | undefined;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const body = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (body.error === undefined) {
          await sleep(300);
          return body.result;
        }
        last = new Error(`${url} ${method}: ${body.error.message}`);
      } catch (error) {
        last = error instanceof Error ? error : new Error(String(error));
      }
      await sleep(800);
    }
  }
  throw last ?? new Error(`${method}: all endpoints failed`);
};

const getLogs = async (
  address: string,
  topics: ReadonlyArray<string | undefined>,
  from: number,
  to: number,
): Promise<ReadonlyArray<{ transactionHash: string }>> =>
  (await rpc("eth_getLogs", [
    { address, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
  ])) as ReadonlyArray<{ transactionHash: string }>;

type Tx = {
  hash: string;
  blockNumber: string;
  chainId: string;
  type: string;
  from: string;
  to?: string;
  value: string;
  nonce: string;
  gas: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  input: string;
};

const getTx = async (hash: string): Promise<Tx> =>
  (await rpc("eth_getTransactionByHash", [hash])) as Tx;

const main = async () => {
  const hashes = new Set<string>([REQUIRED_TX]);
  for (const [address, topics, seed] of SEARCHES) {
    /* 10000-block windows — the endpoints lie about wider ranges. */
    for (let from = seed; from < seed + 10000; from += 9999) {
      const to = Math.min(from + 9998, seed + 9999);
      const logs = await getLogs(address, topics, from, to);
      for (const log of logs) {
        hashes.add(log.transactionHash);
      }
    }
    console.log(
      `logs ${address.slice(0, 8)} ${topics[0]?.slice(0, 10) ?? ""}: ${hashes.size} total`,
    );
  }

  /* Keep only direct calls: tx.to is a pinned proxy, or a USDC call (approvals to the deposit
     contract show up as USDC txs). Cap three transactions per (to, selector). */
  const cases: Tx[] = [];
  const perSelector = new Map<string, number>();
  const all = [...hashes].toSorted((a, b) => a.localeCompare(b));
  for (const hash of all) {
    const tx = await getTx(hash);
    if (tx === null || tx.to === undefined || tx.input === undefined || tx.input === "0x") {
      continue;
    }
    const to = tx.to.toLowerCase();
    const direct = PROXIES.has(to) || to === USDC.toLowerCase();
    if (!direct) {
      continue;
    }
    const key = `${to}:${tx.input.slice(0, 10).toLowerCase()}`;
    const count = perSelector.get(key) ?? 0;
    if (hash !== REQUIRED_TX && count >= 3) {
      continue;
    }
    perSelector.set(key, count + 1);
    cases.push(tx);
  }

  /* Every Fiat24 selector the decoder describes that no collected mainnet call exercised. */
  const DESCRIBED: ReadonlyArray<string> = [
    "0xe89082b3", // transferByAccountId
    "0x48f6adef", // clientPayout
    "0xeb6d2d71", // clientPayoutRef
    "0x72a023fa", // moneyExchangeExactIn
    "0x8f28f584", // moneyExchangeExactOut
    "0xb461e299", // depositTokenViaUsdc
    "0x2d2da806", // depositETH
    "0xa01c3e2b", // depositTokenViaEth
    "0x592b2051", // mintByClient
    "0x6abd75c3", // mintByClientWithETH
    "0x23b872dd", // account transferFrom
    "0x42842e0e", // account safeTransferFrom
    "0xb88d4fde", // account safeTransferFrom(bytes)
  ];
  const seen = new Map<string, number>();
  for (const c of cases) {
    const key = `${(c.to ?? "").toLowerCase()}:${c.input.slice(0, 10).toLowerCase()}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const out = {
    schema: 1,
    capability: "chains.fiat24-mainnet",
    source: {
      kind: "reference",
      name: "arbitrum-archive-rpc",
      evidence:
        "eth_getLogs in ≤10000-block windows seeded from spec/evidence/onchain/event-samples.txt (read-only @qntx/fiat24-audit), eth_getTransactionByHash per match; Tenderly archive endpoint, BlastAPI fallback; direct calls only, ≤3 per (contract, selector)",
      generator: "scripts/vectors/fiat24-mainnet.ts",
      rpc: RPCS,
    },
    stats: {
      cases: cases.length,
      perSelector: Object.fromEntries(
        [...seen.entries()].toSorted((a, b) => a[0].localeCompare(b[0])),
      ),
      missingSelectors: DESCRIBED.filter(
        (sel) => ![...seen.keys()].some((k) => k.endsWith(`:${sel}`)),
      ),
    },
    cases: cases.map((c) => ({
      hash: c.hash,
      block: c.blockNumber,
      chainId: c.chainId,
      type: c.type,
      from: c.from,
      to: c.to ?? null,
      value: c.value,
      nonce: c.nonce,
      gas: c.gas,
      gasPrice: c.gasPrice ?? null,
      maxFeePerGas: c.maxFeePerGas ?? null,
      maxPriorityFeePerGas: c.maxPriorityFeePerGas ?? null,
      input: c.input,
    })),
  };
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${OUT}: ${cases.length} txs, ${seen.size} distinct (to, selector)`);
};

await main();
