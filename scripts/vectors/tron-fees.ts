/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/tron-fees.json: real mainnet transactions with their receipts, the
 * oracle for the engine's TRON bandwidth size rule and fee upper bound.
 *
 * Oracle: the public full node https://api.trongrid.io (blocks from /wallet/getblockbynum, receipts
 * from /wallet/gettransactioninfobyid, chain parameters from /wallet/getchainparameters). Only
 * single-signature, single-contract transactions without a memo are kept — the shape the engine
 * builds.
 *
 * Kinds: TRX to an existing account and to a new one, TRC-10, USDT `transfer` to a holder and to a
 * non-holder, FreezeBalanceV2, VoteWitness, DelegateResource. A new account's `create_time` is the
 * parent block's timestamp (TransferActuator.java:49-55 `getLatestBlockHeaderTimestamp`), so a
 * TRX/TRC-10 recipient counts as new when it was created within a minute before the block AND the
 * transaction paid the system-contract activation fee (an account created by an earlier transaction
 * of the same block existed for this one); otherwise it existed at the parent block.
 *
 * TRC-20 energy cannot be read at the parent block (no public archive state), so each USDT
 * transaction is replayed with /wallet/triggerconstantcontract at the current head with the same
 * owner and contract, twice: once with the original calldata (the recipient now holds USDT) and
 * once with the recipient replaced by a fresh random address (a non-holder). Only transactions from
 * the current maintenance period are used — the dynamic-energy factor is fixed within one period
 * (/wallet/getnextmaintenancetime). The recorded `energyReplay` is the replay of the transaction's
 * class: holder when `energy_usage_total` equals the holder replay, non-holder when it equals the
 * fresh-recipient replay; a transaction matching neither is recorded with `energyReplay` absent and
 * reported. A replay that reverts (the sender spent its balance since) is skipped.
 *
 * Run from the repo root: bun scripts/vectors/tron-fees.ts
 */
import { writeFileSync } from "node:fs";

import { bytesToHex } from "@noble/hashes/utils.js";

const NODE = "https://api.trongrid.io";
const OUT = "vectors/chains/tron-fees.json";
const TARGET = 50;
const USDT = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const TRANSFER = "a9059cbb";
const MAX_BLOCKS = 4000;
const MIN_GAP_MS = 350;

const KINDS = [
  "trx-existing",
  "trx-new",
  "trc10",
  "usdt-holder",
  "usdt-non-holder",
  "freeze",
  "vote",
  "delegate",
  "trx-memo",
] as const;

type Kind = (typeof KINDS)[number];

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const log = (msg: string): void => console.error(msg);

let last = 0;

async function post(path: string, body: unknown): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    last = Date.now();
    try {
      const res = await fetch(NODE + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json: unknown = await res.json();
      if (!isObj(json) || "Error" in json) {
        throw new Error(`node error: ${JSON.stringify(json).slice(0, 200)}`);
      }
      return json;
    } catch (error) {
      if (attempt >= 7) {
        throw error;
      }
      const backoff = Math.min(500 * 2 ** attempt, 15_000);
      log(`  retry ${attempt + 1} ${path}: ${String(error)} (wait ${backoff}ms)`);
      await sleep(backoff);
    }
  }
}

type Sample = {
  readonly kind: Kind;
  readonly txid: string;
  readonly block: number;
  readonly blockTimestamp: number;
  readonly rawDataHex: string;
  readonly receipt: {
    readonly netUsage: number;
    readonly netFee: number;
    readonly energyUsageTotal: number;
    readonly energyFee: number;
    readonly result: string;
  };
  /** Total sun the transaction burned (`info.fee`). */
  readonly fee: number;
  /** TRC-20 only: the replayed estimate of the transaction's class. */
  readonly energyReplay?: { readonly energyUsed: number; readonly energyPenalty: number };
};

const params = async (): Promise<Record<string, number>> => {
  const body = await post("/wallet/getchainparameters", {});
  const list = Array.isArray(body["chainParameter"]) ? body["chainParameter"] : [];
  return Object.fromEntries(
    list.filter(isObj).map((p) => [String(p["key"]), num(p["value"])] as const),
  );
};

const accountCreated = async (address: string): Promise<number | undefined> => {
  const account = await post("/wallet/getaccount", { address });
  return typeof account["create_time"] === "number" ? account["create_time"] : undefined;
};

const replay = async (
  owner: string,
  data: string,
): Promise<{ energyUsed: number; energyPenalty: number } | undefined> => {
  const result = await post("/wallet/triggerconstantcontract", {
    owner_address: owner,
    contract_address: USDT,
    data,
  });
  const status = isObj(result["result"]) ? result["result"] : {};
  if (status["result"] !== true || typeof status["message"] === "string") {
    return undefined;
  }
  return { energyUsed: num(result["energy_used"]), energyPenalty: num(result["energy_penalty"]) };
};

const freshRecipient = (): string =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(20))).padStart(64, "0");

type Candidate = { readonly kind: Kind | "trx" | "usdt"; readonly tx: Json; readonly value: Json };

function classify(tx: Json): Candidate | undefined {
  const raw = tx["raw_data"];
  const sigs = tx["signature"];
  if (!isObj(raw) || !Array.isArray(sigs) || sigs.length !== 1) {
    return undefined;
  }
  const contracts = raw["contract"];
  const contract: unknown =
    Array.isArray(contracts) && contracts.length === 1 ? contracts.at(0) : undefined;
  if (!isObj(contract)) {
    return undefined;
  }
  const { parameter } = contract;
  const value = isObj(parameter) && isObj(parameter["value"]) ? parameter["value"] : undefined;
  if (value === undefined || num(contract["Permission_id"]) !== 0) {
    return undefined;
  }
  // A memo'd TRX transfer is its own kind; a memo on any other contract is not the engine's shape.
  if (raw["data"] !== undefined) {
    return contract["type"] === "TransferContract" ? { kind: "trx-memo", tx, value } : undefined;
  }
  switch (contract["type"]) {
    case "TransferContract":
      return { kind: "trx", tx, value };
    case "TransferAssetContract":
      return { kind: "trc10", tx, value };
    case "TriggerSmartContract": {
      const data = typeof value["data"] === "string" ? value["data"] : "";
      return value["contract_address"] === USDT &&
        data.startsWith(TRANSFER) &&
        num(value["call_value"]) === 0
        ? { kind: "usdt", tx, value }
        : undefined;
    }
    case "FreezeBalanceV2Contract":
      return { kind: "freeze", tx, value };
    case "VoteWitnessContract":
      return { kind: "vote", tx, value };
    case "DelegateResourceContract":
      return { kind: "delegate", tx, value };
    default:
      return undefined;
  }
}

const samples: Record<Kind, Sample[]> = {
  "trx-existing": [],
  "trx-new": [],
  trc10: [],
  "usdt-holder": [],
  "usdt-non-holder": [],
  freeze: [],
  vote: [],
  delegate: [],
  "trx-memo": [],
};
const unmatched: Array<{ txid: string; actual: number; holder: number; fresh: number }> = [];
let reverted = 0;

const TARGETS: Record<Kind, number> = {
  "trx-existing": TARGET,
  "trx-new": TARGET,
  trc10: TARGET,
  "usdt-holder": TARGET,
  "usdt-non-holder": TARGET,
  freeze: TARGET,
  vote: TARGET,
  delegate: TARGET,
  "trx-memo": 25,
};

const full = (kind: Kind): boolean => samples[kind].length >= TARGETS[kind];

async function main(): Promise<void> {
  const chain = await params();
  const head = await post("/walletsolidity/getnowblock", {});
  const header = isObj(head["block_header"]) ? head["block_header"] : {};
  const headRaw = isObj(header["raw_data"]) ? header["raw_data"] : {};
  const headNumber = num(headRaw["number"]);
  const maintenance = await post("/wallet/getnextmaintenancetime", {});
  const periodStart = num(maintenance["num"]) - num(chain["getMaintenanceTimeInterval"]);
  log(`solid head ${headNumber}, maintenance period from ${new Date(periodStart).toISOString()}`);

  for (let n = headNumber; n > headNumber - MAX_BLOCKS && !KINDS.every(full); n--) {
    const block = await post("/wallet/getblockbynum", { num: n });
    const bh = isObj(block["block_header"]) ? block["block_header"] : {};
    const timestamp = num(isObj(bh["raw_data"]) ? bh["raw_data"]["timestamp"] : 0);
    const txs = Array.isArray(block["transactions"]) ? block["transactions"].filter(isObj) : [];
    const inPeriod = timestamp >= periodStart;
    const picked = new Map<string, number>();
    for (const tx of txs) {
      const candidate = classify(tx);
      if (candidate === undefined) {
        continue;
      }
      const room =
        candidate.kind === "trx"
          ? !full("trx-existing") || !full("trx-new")
          : candidate.kind === "usdt"
            ? inPeriod && (!full("usdt-holder") || !full("usdt-non-holder"))
            : !full(candidate.kind);
      // A few per block per kind keeps owners and blocks diverse.
      if (!room || (picked.get(candidate.kind) ?? 0) >= 2) {
        continue;
      }
      picked.set(candidate.kind, (picked.get(candidate.kind) ?? 0) + 1);
      await record(chain, candidate, n, timestamp);
    }
    if (n % 25 === 0) {
      log(
        `block ${n}: ${KINDS.map((k) => `${k}=${samples[k].length}`).join(" ")} reverted=${reverted}`,
      );
    }
  }

  const missing = KINDS.filter((k) => !full(k));
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        source: `${NODE} — scripts/vectors/tron-fees.ts`,
        recordedAt: new Date().toISOString(),
        solidHead: headNumber,
        chainParameters: Object.fromEntries(
          [
            "getTransactionFee",
            "getEnergyFee",
            "getCreateAccountFee",
            "getCreateNewAccountFeeInSystemContract",
            "getMemoFee",
            "getMaxFeeLimit",
            "getCreateNewAccountBandwidthRate",
            "getMaxCreateAccountTxSize",
          ].map((k) => [k, chain[k]]),
        ),
        unmatchedEnergy: unmatched,
        revertedReplays: reverted,
        samples: KINDS.flatMap((k) => samples[k]),
      },
      undefined,
      2,
    )}\n`,
  );
  log(`wrote ${OUT}; short kinds: ${missing.join(", ") || "none"}`);
}

async function record(
  chain: Record<string, number>,
  candidate: Candidate,
  block: number,
  blockTimestamp: number,
): Promise<void> {
  const { tx, value } = candidate;
  const txid = String(tx["txID"]);
  const info = await post("/wallet/gettransactioninfobyid", { value: txid });
  const receipt = isObj(info["receipt"]) ? info["receipt"] : {};
  const base = {
    txid,
    block,
    blockTimestamp,
    rawDataHex: String(tx["raw_data_hex"]),
    receipt: {
      netUsage: num(receipt["net_usage"]),
      netFee: num(receipt["net_fee"]),
      energyUsageTotal: num(receipt["energy_usage_total"]),
      energyFee: num(receipt["energy_fee"]),
      result: typeof receipt["result"] === "string" ? receipt["result"] : "",
    },
    fee: num(info["fee"]),
  };
  if (candidate.kind === "trx-memo") {
    const created = await accountCreated(String(value["to_address"]));
    const paid =
      base.fee - base.receipt.netFee >= num(chain["getCreateNewAccountFeeInSystemContract"]);
    const fresh = created !== undefined && created >= blockTimestamp - 60_000 && paid;
    if (!fresh && !full("trx-memo")) {
      samples["trx-memo"].push({ kind: "trx-memo", ...base });
    }
    return;
  }
  if (candidate.kind === "trx" || candidate.kind === "trc10") {
    const created = await accountCreated(String(value["to_address"]));
    const paid =
      base.fee - base.receipt.netFee >= num(chain["getCreateNewAccountFeeInSystemContract"]);
    const fresh = created !== undefined && created >= blockTimestamp - 60_000 && paid;
    const kind: Kind = candidate.kind === "trc10" ? "trc10" : fresh ? "trx-new" : "trx-existing";
    if (!full(kind)) {
      samples[kind].push({ kind, ...base });
    }
    return;
  }
  if (candidate.kind === "usdt") {
    const data = String(value["data"]);
    const owner = String(value["owner_address"]);
    const holder = await replay(owner, data);
    const fresh = await replay(owner, `${data.slice(0, 8)}${freshRecipient()}${data.slice(72)}`);
    if (holder === undefined || fresh === undefined || base.receipt.result !== "SUCCESS") {
      reverted += 1;
      return;
    }
    const actual = base.receipt.energyUsageTotal;
    const kind: Kind | undefined =
      actual === holder.energyUsed
        ? "usdt-holder"
        : actual === fresh.energyUsed
          ? "usdt-non-holder"
          : undefined;
    if (kind === undefined) {
      unmatched.push({ txid, actual, holder: holder.energyUsed, fresh: fresh.energyUsed });
      return;
    }
    if (!full(kind)) {
      samples[kind].push({
        kind,
        ...base,
        energyReplay: kind === "usdt-holder" ? holder : fresh,
      });
    }
    return;
  }
  samples[candidate.kind].push({ kind: candidate.kind, ...base });
}

await main();
