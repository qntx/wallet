/// <reference types="node" />
/**
 * Regenerates vectors/chains/polymarket-wallets.json — (owner → wallet) pairs observed on-chain and
 * classified by which Polymarket CREATE2 derivation reproduces them.
 *
 * Oracle: on-chain state, not the SDK. Distinct `proxy_wallet` values from paged `GET
 * https://data-api.polymarket.com/v2/trades` are probed at a pinned block on
 * https://polygon-bor-rpc.publicnode.com: `eth_getCode` for the code size, `owner()` (0x8da5cb5b)
 * for deposit wallets and, when that reverts, `getOwners()` (0xa0e67e2b) for single-owner Safes.
 * Each (owner → wallet) pair is then classified by computing the beacon, UUPS and Safe derivations
 * below — the script keeps its own copy of the formulas (viem, no engine import) so the vectors
 * stay an independent oracle. Wallets no derivation reproduces are recorded under `unmatched`,
 * never dropped silently.
 *
 * Run from the repo root: bun scripts/vectors/polymarket-wallets.ts
 */
import { writeFileSync } from "node:fs";

import {
  concat,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  numberToHex,
  padHex,
} from "viem";

const DATA = "https://data-api.polymarket.com";
const RPC = "https://polygon-bor-rpc.publicnode.com";
const WANT_PER_KIND = 4;
const MAX_PAGES = 30;
const MAX_PROBES = 400;

const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET_BEACON = "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a";
const DEPOSIT_WALLET_IMPLEMENTATION = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
const SAFE_FACTORY = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";
const SAFE_INIT_CODE_HASH = "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf";

const BEACON_PREFIX = 0x6100523d8160233d3973n;
const BEACON_RUNTIME: ReadonlyArray<`0x${string}`> = [
  "0x60195155f3363d3d373d3d363d602036600436635c60da",
  "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c",
  "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3",
];
const UUPS_PREFIX = 0x61003d3d8160233d3973n;
const UUPS_RUNTIME: ReadonlyArray<`0x${string}`> = [
  "0x6009",
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076",
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3",
];

const derive = (
  signer: `0x${string}`,
): { beacon: `0x${string}`; uups: `0x${string}`; safe: `0x${string}` } => {
  const args = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }],
    [DEPOSIT_WALLET_FACTORY, padHex(signer, { size: 32 })],
  );
  const salt = keccak256(args);
  const argsBytes = (args.length - 2) / 2;
  const prefix = (p: bigint): `0x${string}` =>
    numberToHex(p + BigInt(argsBytes) * 0x1_00_00_00_00_00_00_00n, { size: 10 });
  const beacon = getCreate2Address({
    from: DEPOSIT_WALLET_FACTORY,
    salt,
    bytecodeHash: keccak256(
      concat([prefix(BEACON_PREFIX), DEPOSIT_WALLET_BEACON, ...BEACON_RUNTIME, args]),
    ),
  });
  const uups = getCreate2Address({
    from: DEPOSIT_WALLET_FACTORY,
    salt,
    bytecodeHash: keccak256(
      concat([prefix(UUPS_PREFIX), DEPOSIT_WALLET_IMPLEMENTATION, ...UUPS_RUNTIME, args]),
    ),
  });
  const safe = getCreate2Address({
    from: SAFE_FACTORY,
    salt: keccak256(encodeAbiParameters([{ type: "address" }], [signer])),
    bytecodeHash: SAFE_INIT_CODE_HASH,
  });
  return { beacon, uups, safe };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const get = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}`);
  }
  return response.json();
};

let rpcId = 0;
const rpc = async (method: string, params: ReadonlyArray<unknown>): Promise<unknown> => {
  rpcId += 1;
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new Error(`${method} answered non-JSON`);
  }
  return body;
};

/** The eth_call result, or undefined — a contract that reverts has no answer. */
const call = async (to: string, data: string, block: string): Promise<string | undefined> => {
  const body = await rpc("eth_call", [{ to, data }, block]);
  if (!isRecord(body) || typeof body["result"] !== "string") {
    return undefined;
  }
  return body["result"];
};

const addressOf = (word: string): `0x${string}` | undefined => {
  const match = /^(?:0x)?0{24}([0-9a-fA-F]{40})$/.exec(word);
  return match === null ? undefined : `0x${match[1] ?? ""}`;
};

/** `getOwners()` → a single owner, or undefined for anything else (multi-owner never matches). */
const singleOwner = (ret: string | undefined): `0x${string}` | undefined => {
  if (ret === undefined || !ret.startsWith("0x") || ret.length < 194) {
    return undefined;
  }
  const words = ret.slice(2);
  /* offset word, then a dynamic array: length + entries. */
  if (BigInt(`0x${words.slice(64, 128)}`) !== 1n) {
    return undefined;
  }
  return addressOf(`0x${words.slice(128, 192)}`);
};

const OWNER_SELECTOR = "0x8da5cb5b";
const GET_OWNERS_SELECTOR = "0xa0e67e2b";

const KINDS = ["beacon", "uups", "safe"] as const;
type Kind = (typeof KINDS)[number];

const wallets = new Set<string>();
let cursor: string | undefined;
for (let page = 0; page < MAX_PAGES && wallets.size < MAX_PROBES; page += 1) {
  const url = `${DATA}/v2/trades?limit=500${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
  // oxlint-disable-next-line eslint/no-await-in-loop -- pages are sequential by cursor
  const page_result = await get(url);
  if (!isRecord(page_result) || !Array.isArray(page_result["data"])) {
    throw new Error("v2/trades answered without a data array");
  }
  for (const row of page_result["data"]) {
    if (isRecord(row) && typeof row["proxy_wallet"] === "string") {
      wallets.add(row["proxy_wallet"]);
    }
  }
  const { pagination } = page_result;
  const next = isRecord(pagination) ? pagination["next_cursor"] : undefined;
  if (typeof next !== "string" || next === "") {
    break;
  }
  cursor = next;
}
console.log(`collected ${wallets.size} distinct proxy_wallets`);

const blockNumber = await rpc("eth_blockNumber", []);
if (!isRecord(blockNumber) || typeof blockNumber["result"] !== "string") {
  throw new Error("eth_blockNumber failed");
}
const block = blockNumber["result"];
console.log(`probing at block ${block} (${Number(block)})`);

type Vector = {
  readonly owner: `0x${string}`;
  readonly wallet: string;
  readonly kind: Kind;
  readonly codeLength: number;
  readonly block: number;
};
type Unmatched = {
  readonly wallet: string;
  readonly codeLength: number;
  readonly owner?: `0x${string}`;
};

const vectors: Vector[] = [];
const unmatched: Unmatched[] = [];
const counts: Record<Kind, number> = { beacon: 0, uups: 0, safe: 0 };

for (const wallet of wallets) {
  if (
    counts.beacon >= WANT_PER_KIND &&
    counts.uups >= WANT_PER_KIND &&
    counts.safe >= WANT_PER_KIND
  ) {
    break;
  }
  // oxlint-disable-next-line eslint/no-await-in-loop -- RPC probes run one at a time
  const codeBody = await rpc("eth_getCode", [wallet, block]);
  const code =
    isRecord(codeBody) && typeof codeBody["result"] === "string" ? codeBody["result"] : "0x";
  const codeLength = Math.max(0, (code.length - 2) / 2);
  if (codeLength === 0) {
    continue;
  }
  // oxlint-disable-next-line eslint/no-await-in-loop -- RPC probes run one at a time
  const ownerRet = await call(wallet, OWNER_SELECTOR, block);
  let owner = ownerRet === undefined ? undefined : addressOf(ownerRet);
  // oxlint-disable-next-line eslint/no-await-in-loop -- RPC probes run one at a time
  owner ??= singleOwner(await call(wallet, GET_OWNERS_SELECTOR, block));
  if (owner === undefined) {
    unmatched.push({ wallet, codeLength });
    continue;
  }
  const candidates = derive(owner);
  const kind = KINDS.find((k) => candidates[k].toLowerCase() === wallet.toLowerCase());
  if (kind === undefined) {
    unmatched.push({ wallet, codeLength, owner });
    continue;
  }
  vectors.push({ owner, wallet, kind, codeLength, block: Number(block) });
  counts[kind] += 1;
  console.log(`${kind} ${counts[kind]}/${WANT_PER_KIND}: ${owner} → ${wallet} (${codeLength} B)`);
}

const missing = KINDS.filter((k) => counts[k] < WANT_PER_KIND).map((k) => `${k} ${counts[k]}`);
if (missing.length > 0) {
  console.log(`WARNING: kinds below ${WANT_PER_KIND}: ${missing.join(", ")}`);
}
console.log(`${unmatched.length} unmatched wallets`);

const out = {
  comment:
    "TEST ONLY. Polymarket account-wallet derivation oracle: real proxy_wallets from data-api /v2/trades, owner read on-chain at the pinned block (owner() for deposit wallets, single-owner getOwners() for Safes) on polygon-bor-rpc.publicnode.com. kind = which CREATE2 derivation (scripts/vectors/polymarket-wallets.ts, same formulas as src/apps/polymarket/wallets.ts) reproduces wallet from owner; unmatched = wallets no derivation reproduced. Generated by scripts/vectors/polymarket-wallets.ts.",
  block: Number(block),
  vectors,
  unmatched,
};

writeFileSync("vectors/chains/polymarket-wallets.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `wrote vectors/chains/polymarket-wallets.json (${vectors.length} vectors, ${unmatched.length} unmatched)`,
);
