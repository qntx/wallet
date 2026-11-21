/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/tron-mainnet.json: real mainnet transactions used as TRON
 * transaction-decoder fixtures, ten per contract-type bucket where the chain provides them.
 *
 * The oracle is the public full node https://api.trongrid.io. Discovery scans blocks with
 * /wallet/getblockbylimitnext (100 blocks per request, walking downwards from START_BLOCK); every
 * chosen txid is then re-fetched with /wallet/gettransactionbyid and checked with sha256(raw_data
 * bytes) == txid. Transactions whose raw_data JSON contains a number that is not a safe integer, or
 * that carry more than one contract, are skipped.
 *
 * Buckets: TransferContract, TransferAssetContract, TriggerSmartContract split into
 * "trc20-transfer" (USDT contract, selector a9059cbb), "trc20-approve" (selector 095ea7b3, any
 * contract) and "trigger-other" (any other selector, preferring call_value > 0),
 * FreezeBalanceV2Contract, UnfreezeBalanceV2Contract, DelegateResourceContract (preferring lock =
 * true), UnDelegateResourceContract, WithdrawExpireUnfreezeContract, CancelAllUnfreezeV2Contract,
 * VoteWitnessContract, WithdrawBalanceContract and AccountPermissionUpdateContract.
 *
 * Run from the repo root: bun scripts/vectors/tron-mainnet.ts
 */
import { writeFileSync } from "node:fs";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const NODE = "https://api.trongrid.io";
const OUT = "vectors/chains/tron-mainnet.json";
const TARGET = 10;
const POOL = 120;
const CHUNK = 100;
const MAX_CHUNKS = 150;
// Rare staking types cluster in this era and blocks are ~3x lighter than current head.
const START_BLOCK = 76_050_000;
const USDT = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

const BUCKETS = [
  "transfer-trx",
  "transfer-asset",
  "trc20-transfer",
  "trc20-approve",
  "trigger-other",
  "freeze-v2",
  "unfreeze-v2",
  "delegate-resource",
  "undelegate-resource",
  "withdraw-expire-unfreeze",
  "cancel-unfreeze-v2",
  "vote-witness",
  "withdraw-balance",
  "account-permission-update",
] as const;

type Bucket = (typeof BUCKETS)[number];

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const log = (msg: string): void => console.error(msg);

async function post(path: string, body: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(NODE + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const json = await res.json();
      if (json !== null && typeof json === "object" && "Error" in json) {
        throw new Error(`node error: ${String(json.Error)}`);
      }
      return json;
    } catch (error) {
      if (attempt >= 7) {
        throw error;
      }
      const wait = Math.min(500 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 400);
      log(`  retry ${attempt + 1} ${path}: ${String(error)} (wait ${wait}ms)`);
      await sleep(wait);
    }
  }
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function safeInts(v: unknown): boolean {
  if (typeof v === "number") {
    return Number.isSafeInteger(v);
  }
  if (Array.isArray(v)) {
    return v.every(safeInts);
  }
  if (isObj(v)) {
    return Object.values(v).every(safeInts);
  }
  return true;
}

type Candidate = {
  bucket: Bucket;
  txid: string;
  owner: string;
  preferred: boolean;
};

/** Maps a single-contract transaction to its bucket, or undefined when unwanted/unusable. */
function classify(tx: Json): Candidate | undefined {
  const raw = tx["raw_data"];
  const txid = tx["txID"];
  if (!isObj(raw) || typeof txid !== "string") {
    return undefined;
  }
  const contracts = raw["contract"];
  if (!Array.isArray(contracts) || contracts.length !== 1) {
    return undefined;
  }
  const contract = contracts.find(isObj);
  if (contract === undefined || !safeInts(raw)) {
    return undefined;
  }
  const { type } = contract;
  const value = contract["parameter"];
  if (typeof type !== "string" || !isObj(value) || !isObj(value["value"])) {
    return undefined;
  }
  const v = value["value"];
  const owner = typeof v["owner_address"] === "string" ? v["owner_address"] : "";

  switch (type) {
    case "TransferContract":
      return { bucket: "transfer-trx", txid, owner, preferred: false };
    case "TransferAssetContract":
      return { bucket: "transfer-asset", txid, owner, preferred: false };
    case "TriggerSmartContract": {
      const data = typeof v["data"] === "string" ? v["data"] : "";
      const selector = data.slice(0, 8).toLowerCase();
      if (v["contract_address"] === USDT && selector === "a9059cbb") {
        return { bucket: "trc20-transfer", txid, owner, preferred: false };
      }
      if (selector === "095ea7b3") {
        return { bucket: "trc20-approve", txid, owner, preferred: false };
      }
      if (selector === "a9059cbb") {
        return undefined;
      }
      const callValue = typeof v["call_value"] === "number" ? v["call_value"] : 0;
      return { bucket: "trigger-other", txid, owner, preferred: callValue > 0 };
    }
    case "FreezeBalanceV2Contract":
      return { bucket: "freeze-v2", txid, owner, preferred: false };
    case "UnfreezeBalanceV2Contract":
      return { bucket: "unfreeze-v2", txid, owner, preferred: false };
    case "DelegateResourceContract":
      return { bucket: "delegate-resource", txid, owner, preferred: v["lock"] === true };
    case "UnDelegateResourceContract":
      return { bucket: "undelegate-resource", txid, owner, preferred: false };
    case "WithdrawExpireUnfreezeContract":
      return { bucket: "withdraw-expire-unfreeze", txid, owner, preferred: false };
    case "CancelAllUnfreezeV2Contract":
      return { bucket: "cancel-unfreeze-v2", txid, owner, preferred: false };
    case "VoteWitnessContract":
      return { bucket: "vote-witness", txid, owner, preferred: false };
    case "WithdrawBalanceContract":
      return { bucket: "withdraw-balance", txid, owner, preferred: false };
    case "AccountPermissionUpdateContract":
      return { bucket: "account-permission-update", txid, owner, preferred: false };
    default:
      return undefined;
  }
}

/** Orders a pool: `preferred` entries first; inside each group distinct owners first. */
function order(pool: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const group of [pool.filter((c) => c.preferred), pool.filter((c) => !c.preferred)]) {
    const seen = new Set<string>();
    for (const c of group) {
      if (seen.has(c.owner)) {
        continue;
      }
      seen.add(c.owner);
      out.push(c);
    }
    for (const c of group) {
      if (!out.includes(c)) {
        out.push(c);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const pools = new Map<Bucket, Candidate[]>(BUCKETS.map((b) => [b, []]));
  const open = (): boolean => BUCKETS.some((b) => (pools.get(b) ?? []).length < POOL);

  let low = START_BLOCK - CHUNK;
  let chunks = 0;
  let lastBlock = START_BLOCK;
  while (open() && chunks < MAX_CHUNKS && low > 0) {
    const res = await post("/wallet/getblockbylimitnext", {
      startNum: low,
      endNum: low + CHUNK,
    });
    const blocks = isObj(res) && Array.isArray(res["block"]) ? res["block"] : [];
    if (blocks.length === 0) {
      throw new Error(`empty block range ${low}..${low + CHUNK}`);
    }
    for (const block of blocks) {
      if (!isObj(block)) {
        continue;
      }
      const txs = block["transactions"];
      if (!Array.isArray(txs)) {
        continue;
      }
      for (const tx of txs) {
        if (!isObj(tx)) {
          continue;
        }
        const cand = classify(tx);
        if (cand === undefined) {
          continue;
        }
        const pool = pools.get(cand.bucket);
        if (pool !== undefined && pool.length < POOL) {
          pool.push(cand);
        }
      }
    }
    lastBlock = low;
    chunks += 1;
    low -= CHUNK;
    const status = BUCKETS.map((b) => `${b}:${pools.get(b)?.length ?? 0}`).join(" ");
    log(`chunk ${chunks} [${low + CHUNK}..${low + 2 * CHUNK}) ${status}`);
    await sleep(350);
  }

  const chosen = new Map<Bucket, Candidate[]>(BUCKETS.map((b) => [b, []]));
  log("fetching + verifying selected txids");

  const transactions: Json[] = [];
  for (const bucket of BUCKETS) {
    for (const cand of order(pools.get(bucket) ?? [])) {
      if ((chosen.get(bucket) ?? []).length >= TARGET) {
        break;
      }
      const fetched = await post("/wallet/gettransactionbyid", { value: cand.txid });
      const raw = isObj(fetched) ? fetched["raw_data"] : undefined;
      const rawHex = isObj(fetched) ? fetched["raw_data_hex"] : undefined;
      const signature = isObj(fetched) ? fetched["signature"] : undefined;
      if (!isObj(raw) || typeof rawHex !== "string" || !safeInts(raw)) {
        log(`  skip ${cand.txid}: refetch unusable`);
        continue;
      }
      const contracts = raw["contract"];
      if (!Array.isArray(contracts) || contracts.length !== 1) {
        continue;
      }
      const contract = contracts.find(isObj);
      if (contract === undefined) {
        continue;
      }
      const digest = bytesToHex(sha256(hexToBytes(rawHex)));
      if (digest !== cand.txid) {
        throw new Error(`sha256 mismatch for ${cand.txid}: ${digest}`);
      }
      transactions.push({
        bucket: cand.bucket,
        txid: cand.txid,
        type: contract["type"],
        raw_data_hex: rawHex,
        raw_data: raw,
        signature,
      });
      chosen.get(bucket)?.push(cand);
      await sleep(150);
    }
  }

  const doc = {
    source: "https://api.trongrid.io /wallet/gettransactionbyid",
    fetched: new Date().toISOString(),
    discovery: `scanned blocks ${lastBlock}..${START_BLOCK} via /wallet/getblockbylimitnext (${chunks} chunks of ${CHUNK} blocks)`,
    transactions,
  };
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  const counts = BUCKETS.map((b) => `${b}=${transactions.filter((t) => t["bucket"] === b).length}`);
  console.log(`wrote ${OUT}: ${transactions.length} transactions (${counts.join(" ")})`);
}

await main();
