/**
 * The stub upstream world for the capacity harness: one fetch answers every provider the gateway
 * can reach — EVM and Solana JSON-RPC (incl. batches, Multicall3 aggregate3, alchemy transfers),
 * Esplora, the TRON node and indexer, CoinGecko and DefiLlama prices, and the token-list source
 * documents — from a per-wallet model that is either empty ("fresh") or populated ("used", ≥50
 * history rows per family). Calls are recorded and attributed to the provider's billing account
 * (`auth ?? id` on the provider row; the code-built providers by URL prefix). A path with no stub
 * answers 404 and lands in `unstubbed` — scenarios assert that list stays empty.
 */
import { readFileSync } from "node:fs";

import { hex as scureHex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { NETWORK, p2pkh, p2sh, p2tr, p2wpkh, Transaction } from "@scure/btc-signer";
import { decodeFunctionData, encodeFunctionResult, keccak256 } from "viem";

import { scriptPubKey, scripthash } from "../../src/chains/bitcoin-scan.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);

const FIXTURES = new URL("../../../../apps/gateway/tests/fixtures/", import.meta.url);
const fixture = (name: string): unknown => {
  const parsed: unknown = JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
  return isObject(parsed) ? parsed["body"] : undefined;
};

export type UpstreamCall = { readonly account: string; readonly method: string };
export type UpstreamStats = { calls: number; units: number };

type Tx = Record<string, unknown>;

/** The world the stub serves: `fresh` is every map empty. */
export type WalletModel = {
  readonly evm: { readonly balance: bigint; readonly transfers: ReadonlyArray<Tx> };
  readonly solana: {
    readonly lamports: number;
    readonly signatures: ReadonlyArray<Tx>;
    readonly txs: ReadonlyMap<string, Tx>;
  };
  readonly bitcoin: ReadonlyMap<string, { txs: ReadonlyArray<Tx>; utxos: ReadonlyArray<Tx> }>;
  readonly tron: {
    readonly exists: boolean;
    readonly balance: number;
    readonly heldTrc20: ReadonlyArray<string>;
    readonly transactions: ReadonlyArray<Tx>;
    readonly trc20: ReadonlyArray<Tx>;
  };
};

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

let counter = 0;
const hex = (n: number): string => `0x${n.toString(16)}`;
const fakeHash = (seed: string): string =>
  `0x${keccak256(new TextEncoder().encode(seed)).slice(2).padStart(64, "0").slice(0, 64)}`;
const fakeId = (seed: string): string => keccak256(new TextEncoder().encode(seed)).slice(2);

/* ------- model builders ------- */

const evmTransfers = (address: string, count: number): Tx[] =>
  Array.from({ length: count }, (_, i) => ({
    blockNum: hex(20_000_000 + i),
    uniqueId: `${fakeId(`t${i}`)}:log-${i}`,
    hash: fakeHash(`tx-${i}`),
    from: `0x${"1".repeat(40)}`,
    to: address,
    value: 0.001 * (i + 1),
    erc721TokenId: null,
    erc1155Metadata: null,
    tokenId: null,
    asset: "ETH",
    category: "external",
    rawContract: {
      value: `0x${(1_000_000_000_000_000n * BigInt(i + 1)).toString(16)}`,
      address: null,
      decimal: "0x12",
    },
    metadata: { blockTimestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString() },
  }));

const solanaSignatures = (count: number): { signatures: Tx[]; txs: Map<string, Tx> } => {
  const txs = new Map<string, Tx>();
  const signatures = Array.from({ length: count }, (_, i) => {
    const sig = `sig-${"a".repeat(60)}-${i}`;
    txs.set(sig, {
      slot: 300_000_000 + i,
      blockTime: 1_700_000_000 + i * 60,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1_000_000_000, 2_000_000_000],
        postBalances: [1_000_001_000, 1_999_999_000],
        logMessages: [],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: "11111111111111111111111111111111", signer: false, writable: false },
          ],
          instructions: [],
        },
        signatures: [sig],
      },
    });
    return {
      signature: sig,
      slot: 300_000_000 + i,
      err: null,
      memo: null,
      blockTime: 1_700_000_000 + i * 60,
      confirmationStatus: "finalized",
    };
  });
  return { signatures, txs };
};

const tronTransfers = (count: number): Tx[] =>
  Array.from({ length: count }, (_, i) => ({
    txID: fakeId(`trontx${i}`),
    block_timestamp: 1_700_000_000_000 + i * 60_000,
    net_usage: 300,
    ret: [{ contractRet: "SUCCESS" }],
    raw_data: {
      contract: [
        {
          parameter: {
            value: {
              amount: 1_000_000 + i,
              owner_address: "41000000000000000000000000000000000000000000",
              to_address: "41000000000000000000000000000000000000000000",
            },
            type: "TransferContract",
            type_url: "type.googleapis.com/protocol.TransferContract",
          },
          type: "TransferContract",
        },
      ],
      ref_block_bytes: "0000",
      ref_block_hash: "0000000000000000",
      expiration: 1_700_000_060_000,
      timestamp: 1_700_000_000_000,
    },
    signature: ["00"],
  }));

const trc20Transfers = (contract: string, count: number): Tx[] =>
  Array.from({ length: count }, (_, i) => ({
    transaction_id: fakeId(`trc20-${i}`),
    token_info: {
      symbol: "TUSD",
      address: contract,
      decimals: 6,
      name: "Test USD",
    },
    block_timestamp: 1_700_000_000_000 + i * 60_000,
    from: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    to: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    type: "Transfer",
    value: String(1_000_000 + i),
  }));

const btcTx = (i: number, address: string, confirmed: boolean, height: number): Tx => ({
  txid: fakeId(`btc-${i}`),
  version: 2,
  locktime: 0,
  size: 200,
  weight: 800,
  fee: 1000,
  vin: [
    {
      txid: fakeId(`prev-${i}`),
      vout: 0,
      is_coinbase: false,
      prevout: { scriptpubkey: "", scriptpubkey_address: "", value: 50_000 },
      scriptsig: "",
      witness: [],
      sequence: 0xff_ff_ff_fd,
    },
  ],
  vout: [
    {
      scriptpubkey:
        address === "" ? `0014${"11".repeat(20)}` : scureHex.encode(scriptPubKey(address, NETWORK)),
      scriptpubkey_address: address,
      scriptpubkey_type: "v0_p2wpkh",
      value: 40_000 + i * 100,
    },
  ],
  status: confirmed
    ? {
        confirmed: true,
        block_height: height,
        block_hash: fakeId(`blk${height}`),
        block_time: 1_700_000_000,
      }
    : { confirmed: false },
});

/**
 * Builds the populated ("used") model. `bitcoin` maps scripthash → history: give it every derived
 * address so the stub can answer `/scripthash/:h/txs` — used addresses get the transactions the
 * spec sizes (one address over 25 confirmed rows so `/txs/chain` paging is exercised).
 */
export const usedModel = (opts: {
  readonly evmAddress: string;
  readonly bitcoin: ReadonlyMap<string, { txs: ReadonlyArray<Tx>; utxos: ReadonlyArray<Tx> }>;
  readonly trc20Contract: string;
}): WalletModel => {
  const { signatures, txs } = solanaSignatures(60);
  return {
    evm: { balance: 1_500_000_000_000_000_000n, transfers: evmTransfers(opts.evmAddress, 60) },
    solana: { lamports: 2_000_000_000, signatures, txs },
    bitcoin: opts.bitcoin,
    tron: {
      exists: true,
      balance: 1_577_390_314,
      heldTrc20: [opts.trc20Contract],
      transactions: tronTransfers(60),
      trc20: trc20Transfers(opts.trc20Contract, 60),
    },
  };
};

export const freshModel = (): WalletModel => ({
  evm: { balance: 0n, transfers: [] },
  solana: { lamports: 0, signatures: [], txs: new Map() },
  bitcoin: new Map(),
  tron: { exists: false, balance: 0, heldTrc20: [], transactions: [], trc20: [] },
});

/** A real serialized funding transaction paying 100 000 sats to `address` (+ `raw` for /tx/hex). */
const fundTx = (address: string, seed: string): Tx => {
  const tx = new Transaction();
  tx.addInput({ txid: fakeId(`prev-${seed}`), index: 0 });
  tx.addOutputAddress(address, 100_000n, NETWORK);
  return {
    txid: tx.id,
    vout: 0,
    status: { confirmed: true, block_height: 800_000, block_hash: fakeId(`blk-${seed}`) },
    value: 100_000,
    raw: tx.hex,
  };
};

/**
 * The BTC used set: scripthash → txs/utxos for the given bip84 receive/change addresses, with
 * `hotAddress` carrying >25 confirmed rows plus UTXOs so both `/txs` paging and `/utxo` serve
 * data.
 */
export const bitcoinUsed = (
  network: typeof NETWORK,
  addresses: ReadonlyMap<string, string>,
): Map<string, { txs: Tx[]; utxos: Tx[] }> => {
  const map = new Map<string, { txs: Tx[]; utxos: Tx[] }>();
  for (const [name, address] of addresses) {
    const hot = name === "btc.bip84:0:0";
    const used =
      hot || name === "btc.bip84:0:1" || name === "btc.bip84:0:2" || name === "btc.bip84:1:0";
    const txs = used
      ? Array.from({ length: hot ? 30 : 4 }, (_, i) => btcTx(i, address, true, 800_000 + i))
      : [];
    // The funding output is a real serialized transaction: sends fetch `/tx/:txid/hex` for
    // selected inputs and reject the bytes unless they decode to the same txid.
    const utxos = used ? [fundTx(address, `u-${name}`)] : [];
    map.set(scripthash(address, network), { txs, utxos });
  }
  return map;
};

/** Derives template addresses from an account xpub (`{template}:{chain}:{index}` keys). */
export const bitcoinAddresses = (
  xpubs: Readonly<Record<string, string>>,
  indices: ReadonlyArray<{ readonly chain: 0 | 1; readonly max: number }>,
): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [template, xpub] of Object.entries(xpubs)) {
    const node = HDKey.fromExtendedKey(xpub);
    for (const { chain, max } of indices) {
      for (let i = 0; i < max; i += 1) {
        const child = node.deriveChild(chain).deriveChild(i);
        if (child.publicKey === null) {
          throw new Error("no child pubkey");
        }
        const key = child.publicKey;
        const addr =
          template === "btc.bip84"
            ? p2wpkh(key, NETWORK).address
            : template === "btc.bip86"
              ? p2tr(key.slice(1), undefined, NETWORK).address
              : template === "btc.bip49"
                ? p2sh(p2wpkh(key, NETWORK), NETWORK).address
                : p2pkh(key, NETWORK).address;
        out.set(`${template}:${String(chain)}:${String(i)}`, addr);
      }
    }
  }
  return out;
};

/* ------- the stub fetch ------- */

export type Stub = {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: UpstreamCall[];
  readonly unstubbed: string[];
  /** Engine-internal calls that are not billed gateway upstreams (e.g. Spark authn) — never billed. */
  readonly internal: string[];
};

const evmCall = (model: WalletModel, method: string, params: unknown): unknown => {
  const p = Array.isArray(params) ? params.filter(isObject) : [];
  switch (method) {
    case "eth_chainId":
      return hex(1);
    case "net_version":
      return "1";
    case "eth_syncing":
      return false;
    case "eth_blockNumber":
      return hex(21_000_000);
    case "eth_getBalance":
      return `0x${model.evm.balance.toString(16)}`;
    case "eth_getTransactionCount":
      return hex(1);
    case "eth_getCode":
      return "0x";
    case "eth_gasPrice":
      return hex(1_000_000_000);
    case "eth_maxPriorityFeePerGas":
      return hex(100_000_000);
    case "eth_feeHistory":
      return {
        oldestBlock: hex(20_999_990),
        baseFeePerGas: [hex(1_000_000_000), hex(1_000_000_000)],
        gasUsedRatio: [0.5],
        reward: [[hex(100_000_000)]],
      };
    case "eth_estimateGas":
      return hex(21_000);
    case "eth_getBlockByNumber":
      return {
        number: hex(21_000_000),
        hash: fakeHash("block"),
        parentHash: fakeHash("parent"),
        timestamp: hex(1_700_000_000),
        gasLimit: hex(30_000_000),
        baseFeePerGas: hex(1_000_000_000),
        transactions: [],
      };
    case "eth_getBlockByHash":
      return null;
    case "eth_getLogs":
      return [];
    case "eth_getTransactionReceipt":
      return {
        transactionHash: p[0],
        blockNumber: hex(21_000_000),
        blockHash: fakeHash("block"),
        status: "0x1",
        gasUsed: hex(21_000),
        effectiveGasPrice: hex(1_000_000_000),
        logs: [],
        to: "0x000000000000000000000000000000000000dead",
        from: `0x${"1".repeat(40)}`,
      };
    case "eth_simulateV1": {
      const sim = obj(p[0])?.["calls"];
      return [
        {
          calls: (Array.isArray(sim) ? sim : []).map(() => ({
            status: "0x1",
            returnData: "0x",
          })),
        },
      ];
    }
    case "alchemy_getAssetTransfers":
      return { transfers: model.evm.transfers, pageKey: undefined };
    case "eth_sendRawTransaction":
      counter += 1;
      return fakeHash(`raw-${String(counter)}`);
    case "eth_call": {
      const rawData = obj(p[0])?.["data"];
      const data: `0x${string}` =
        typeof rawData === "string" && rawData.startsWith("0x") ? `0x${rawData.slice(2)}` : "0x";
      // aggregate3's selector identifies a Multicall3 call on any deployment (the ZKsync stack
      // uses a different address than the canonical 0xcA11 contract).
      if (data.startsWith("0x82ad56cb")) {
        const abi = [
          {
            type: "function",
            name: "aggregate3",
            stateMutability: "payable",
            inputs: [
              {
                name: "calls",
                type: "tuple[]",
                components: [
                  { name: "target", type: "address" },
                  { name: "allowFailure", type: "bool" },
                  { name: "callData", type: "bytes" },
                ],
              },
            ],
            outputs: [
              {
                name: "returnData",
                type: "tuple[]",
                components: [
                  { name: "success", type: "bool" },
                  { name: "returnData", type: "bytes" },
                ],
              },
            ],
          },
        ] as const;
        const decoded = decodeFunctionData({ abi, data });
        const innerCalls = Array.isArray(decoded.args[0]) ? decoded.args[0] : [];
        const returnData = innerCalls.map((c) => {
          const cd = obj(c)?.["callData"];
          const cdData: `0x${string}` =
            typeof cd === "string" && cd.startsWith("0x") ? `0x${cd.slice(2)}` : "0x";
          const inner = evmCall(model, "eth_call", [{ data: cdData }, "latest"]);
          const rd: `0x${string}` =
            typeof inner === "string" && inner.startsWith("0x") ? `0x${inner.slice(2)}` : "0x";
          return { success: true, returnData: rd };
        });
        return encodeFunctionResult({ abi, functionName: "aggregate3", result: returnData });
      }
      if (data.startsWith("0x70a08236")) {
        // balanceOf(address) — tokens are not held; answer zero.
        return `0x${"0".repeat(64)}`;
      }
      if (data.startsWith("0x06fdde03") || data.startsWith("0x95d89b41")) {
        return `0x${"0".repeat(64)}`;
      }
      if (data.startsWith("0x313ce567")) {
        return `0x${"0".repeat(63)}12`;
      }
      return "0x";
    }
    default:
      return null;
  }
};

const solanaCall = (model: WalletModel, method: string, params: unknown): unknown => {
  const p: ReadonlyArray<unknown> = Array.isArray(params) ? params : [];
  switch (method) {
    case "getGenesisHash":
      return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpJNTMcw4JMDr9VjpEFc8FGqtCpBc3fZDFLXTaq9xBQFahEm5KBGxdb1YBh4e6TrXmgqP8ETFkTB9oXGBNVu2k";
    case "getBalance":
      return { context: { slot: 300_000_000 }, value: model.solana.lamports };
    case "getLatestBlockhash":
      return {
        context: { slot: 300_000_000 },
        value: {
          blockhash: "4npcBSGZ74BcC7snbk4vPZLLq6xJgUk7oRvcRM5sKwzP",
          lastValidBlockHeight: 300_000_100,
        },
      };
    case "getBlockHeight":
      return 300_000_100;
    case "getSlot":
      return 300_000_000;
    case "getSignaturesForAddress":
      return model.solana.signatures;
    case "getTransaction":
      return model.solana.txs.get(typeof p[0] === "string" ? p[0] : "") ?? null;
    case "getTokenAccountsByOwner":
      return { context: { slot: 300_000_000 }, value: [] };
    case "getTokenAccountBalance":
      return { context: { slot: 300_000_000 }, value: { amount: "0", decimals: 0, uiAmount: 0 } };
    case "getTokenSupply":
      return { context: { slot: 300_000_000 }, value: { amount: "0", decimals: 0, uiAmount: 0 } };
    case "getAccountInfo":
      return { context: { slot: 300_000_000 }, value: null };
    case "getMinimumBalanceForRentExemption":
      return 890_880;
    case "getFeeForMessage":
      return { context: { slot: 300_000_000 }, value: 5000 };
    case "getRecentPrioritizationFees":
      return [];
    case "simulateTransaction":
      return { context: { slot: 300_000_000 }, value: { err: null, logs: [], unitsConsumed: 100 } };
    case "sendTransaction":
      counter += 1;
      return `sig-${"b".repeat(80)}${String(counter)}`;
    case "getHealth":
      return "ok";
    default:
      return null;
  }
};

const tronAccount = (model: WalletModel, address: string): unknown => {
  if (!model.tron.exists) {
    return {};
  }
  const body = structuredClone(obj(fixture("tron/mainnet-trongrid/account-holder.json")) ?? {});
  body["address"] = address;
  body["balance"] = model.tron.balance;
  return body;
};

const tronNode = (model: WalletModel, path: string, body: Tx, address: string): unknown => {
  switch (path) {
    case "/wallet/getaccount": {
      const wanted = body["address"];
      return tronAccount(model, typeof wanted === "string" ? wanted : address);
    }
    case "/wallet/getaccountresource":
      return fixture("tron/mainnet-trongrid/accountresource.json");
    case "/wallet/getReward":
      return fixture("tron/mainnet-trongrid/getreward.json");
    case "/wallet/getchainparameters":
      return fixture("tron/mainnet-trongrid/chainparameters.json");
    case "/wallet/getnowblock":
      return fixture("tron/mainnet-trongrid/nowblock-full.json");
    case "/walletsolidity/getnowblock":
      return fixture("tron/mainnet-trongrid/nowblock-solidity.json");
    case "/wallet/getblockbynum":
      return fixture("tron/mainnet-trongrid/blockbynum-full.json");
    case "/walletsolidity/getblockbynum":
      return fixture("tron/mainnet-trongrid/blockbynum-solidity.json");
    case "/walletsolidity/gettransactioninfobyid":
      return fixture("tron/mainnet-trongrid/transactioninfobyid-solidity.json");
    case "/wallet/triggerconstantcontract":
      return fixture("tron/mainnet-trongrid/triggerconstantcontract.json");
    case "/wallet/gettransactionbyid":
      return fixture("tron/mainnet-trongrid/transactionbyid.json");
    case "/wallet/gettransactioninfobyid":
      return fixture("tron/mainnet-trongrid/transactioninfobyid.json");
    case "/wallet/broadcasthex":
      return { result: true, txid: fakeId("tron-broadcast") };
    case "/wallet/getavailableunfreezecount":
      return fixture("tron/mainnet-trongrid/availableunfreezecount.json");
    case "/wallet/getcandelegatedmaxsize":
      return fixture("tron/mainnet-trongrid/candelegatedmaxsize-bandwidth.json");
    case "/wallet/getdelegatedresourcev2":
      return fixture("tron/mainnet-trongrid/delegatedresourcev2.json");
    case "/wallet/getassetissuebyid":
      return fixture("tron/mainnet-trongrid/assetissuebyid.json");
    case "/wallet/listwitnesses":
      return fixture("tron/mainnet-trongrid/listwitnesses.json");
    default:
      return undefined;
  }
};

const tronIndexer = (model: WalletModel, sub: string): unknown => {
  // `""` is the bare account-info GET — the gateway rewrites the engine's
  // `/v1/accounts/account` POST into `GET /v1/accounts/<address>` on TronGrid.
  if (!model.tron.exists) {
    return sub === "/account" || sub === ""
      ? { data: [], success: true, meta: { at: 1_700_000_000_000, page_size: 0 } }
      : {
          data: [],
          success: true,
          meta: { fingerprint: "", at: 1_700_000_000_000, links: { next: "" } },
        };
  }
  if (sub === "/account" || sub === "") {
    const body = structuredClone(
      obj(fixture("tron/mainnet-trongrid/v1-accounts-account.json")) ?? {},
    );
    const rows = Array.isArray(body["data"]) ? body["data"].filter(isObject) : [];
    for (const row of rows) {
      row["balance"] = model.tron.balance;
      row["trc20"] = model.tron.heldTrc20.map((contract) => ({ [contract]: "12345678" }));
    }
    body["data"] = rows;
    return body;
  }
  if (sub === "/transactions") {
    return {
      data: model.tron.transactions,
      success: true,
      meta: { at: 1_700_000_000_000, fingerprint: "", links: { next: "" }, page_size: 60 },
    };
  }
  if (sub === "/transactions/trc20") {
    return {
      data: model.tron.trc20,
      success: true,
      meta: { at: 1_700_000_000_000, fingerprint: "", links: { next: "" }, page_size: 60 },
    };
  }
  return undefined;
};

const ESP_TX_PAGE = /\/scripthash\/([0-9a-f]+)\/txs(?:\/chain\/([0-9a-f]+))?/;

const esConfirmed = (t: Tx): boolean => obj(t["status"])?.["confirmed"] === true;

const esplora = (model: WalletModel, path: string, method: string): unknown => {
  const m = ESP_TX_PAGE.exec(path);
  if (m !== null) {
    const entry = model.bitcoin.get(m[1] ?? "") ?? { txs: [], utxos: [] };
    const mempool = entry.txs.filter((t) => !esConfirmed(t));
    const confirmed = entry.txs.filter(esConfirmed);
    if (m[2] === undefined) {
      return [...mempool.slice(0, 50), ...confirmed.slice(0, 25)];
    }
    const last = confirmed.findIndex((t) => t["txid"] === m[2]);
    return last === -1 ? [] : confirmed.slice(last + 1, last + 26);
  }
  if (/^\/scripthash\/[0-9a-f]+\/txs\/mempool$/.test(path)) {
    const h = /\/scripthash\/([0-9a-f]+)\//.exec(path)?.[1] ?? "";
    const entry = model.bitcoin.get(h) ?? { txs: [], utxos: [] };
    return entry.txs.filter((t) => !esConfirmed(t)).slice(0, 50);
  }
  if (/^\/scripthash\/[0-9a-f]+\/utxo$/.test(path)) {
    const h = /\/scripthash\/([0-9a-f]+)\//.exec(path)?.[1] ?? "";
    return model.bitcoin.get(h)?.utxos ?? [];
  }
  if (path === "/blocks/tip/height") {
    return json(830_000);
  }
  if (path === "/fee-estimates") {
    return { "1": 12, "2": 10, "3": 9, "6": 8, "10": 6, "20": 4, "144": 2, "504": 1, "1008": 1 };
  }
  if (path === "/block-height/0") {
    return fakeId("genesis").slice(0, 64);
  }
  if (path === "/tx" && method === "POST") {
    return fakeId("broadcast").slice(0, 64);
  }
  if (/^\/tx\/[0-9a-f]+\/status$/.test(path)) {
    return {
      confirmed: true,
      block_height: 800_000,
      block_hash: fakeId("blk"),
      block_time: 1_700_000_000,
    };
  }
  if (/^\/tx\/[0-9a-f]+$/.test(path)) {
    return btcTx(0, "", true, 800_000);
  }
  if (/^\/tx\/[0-9a-f]+\/hex$/.test(path)) {
    const want = /\/tx\/([0-9a-f]+)\/hex$/.exec(path)?.[1] ?? "";
    for (const entry of model.bitcoin.values()) {
      for (const u of entry.utxos) {
        if (u["txid"] === want && typeof u["raw"] === "string") {
          return u["raw"];
        }
      }
    }
    return "00".repeat(64);
  }
  return undefined;
};

const COINGECKO = "https://pro-api.coingecko.com/api/v3";
const DEFILLAMA = "https://coins.llama.fi";

const prices = (url: URL): unknown => {
  // CoinGecko simple/price + simple/token_price/<platform>
  if (url.pathname === "/api/v3/simple/price") {
    const body: Record<string, Record<string, number>> = {};
    for (const id of (url.searchParams.get("ids") ?? "").split(",")) {
      const key = decodeURIComponent(id);
      if (key !== "") {
        body[key] = { usd: 1, eur: 0.9, usd_24h_change: 0.5, last_updated_at: 1_700_000_000 };
      }
    }
    return body;
  }
  const tokenPrice = /^\/api\/v3\/simple\/token_price\/([a-z0-9-]+)$/.exec(url.pathname);
  if (tokenPrice !== null) {
    const body: Record<string, Record<string, number>> = {};
    for (const addr of (url.searchParams.get("contract_addresses") ?? "").split(",")) {
      if (addr !== "") {
        body[addr] = { usd: 1, eur: 0.9, usd_24h_change: 0.5, last_updated_at: 1_700_000_000 };
      }
    }
    return body;
  }
  // DefiLlama /prices/current/<comma-ids> and /percentage/<comma-ids>
  const llama = /^\/(prices\/current|percentage)\/(.+)$/.exec(url.pathname);
  if (llama !== null) {
    const ids = (llama[2] ?? "")
      .split(",")
      .map((x) => decodeURIComponent(x))
      .filter((x) => x !== "");
    if (llama[1] === "prices/current") {
      const coins: Record<string, unknown> = {};
      for (const id of ids) {
        coins[id] = {
          decimals: 18,
          price: 1,
          symbol: id.split(":").pop() ?? "?",
          timestamp: 1_700_000_000,
          confidence: 0.99,
        };
      }
      return { coins };
    }
    const coins: Record<string, number> = {};
    for (const id of ids) {
      coins[id] = 0.5;
    }
    return { coins };
  }
  return undefined;
};

/**
 * The upstream fetch. `accounts` maps URL prefix → billing account; gateway forwarder URLs carry
 * the provider's base `url`, so longest-prefix matching attributes the call.
 */
export const stubUpstream = (
  model: WalletModel,
  prefixes: ReadonlyMap<string, string>,
  tronAddress: string,
): Stub => {
  const calls: UpstreamCall[] = [];
  const unstubbed: string[] = [];
  const internal: string[] = [];
  const accountOf = (target: string): string => {
    let best: string | undefined;
    let len = 0;
    for (const [prefix, account] of prefixes) {
      if (target.startsWith(prefix) && prefix.length > len) {
        best = account;
        len = prefix.length;
      }
    }
    return best ?? "unstubbed-origin";
  };

  const respond = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const account = accountOf(target);
    const record = (name: string): void => {
      calls.push({ account, method: name });
    };
    const body = async (): Promise<unknown> => {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof raw !== "string" || raw === "") {
        return undefined;
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    };
    const rpcCalls = async (): Promise<{
      calls: ReadonlyArray<{ method: string; params?: unknown; id?: unknown }>;
      batched: boolean;
    }> => {
      const parsed = await body();
      const batched = Array.isArray(parsed);
      const items = batched ? parsed.filter(isObject) : isObject(parsed) ? [parsed] : [];
      const calls = items.flatMap((o) => {
        const { method } = o;
        return typeof method === "string" ? [{ method, params: o["params"], id: o["id"] }] : [];
      });
      return { calls, batched };
    };
    const rpcReply = (
      batch: {
        calls: ReadonlyArray<{ method: string; params?: unknown; id?: unknown }>;
        batched: boolean;
      },
      answer: (m: string, p: unknown) => unknown,
    ): Response => {
      const results = batch.calls.map((c) => ({
        jsonrpc: "2.0",
        id: c.id ?? null,
        result: answer(c.method, c.params),
      }));
      return json(
        batch.batched ? results : (results[0] ?? { jsonrpc: "2.0", id: null, result: null }),
      );
    };

    // JSON-RPC upstreams (EVM, Solana) — everything POSTs a JSON-RPC body.
    if (
      method === "POST" &&
      /\.(g\.alchemy\.com|drpc\.live|ankr\.com|publicnode|1rpc|zan\.top|nodies|hyperliquid)/.test(
        url.hostname,
      )
    ) {
      const batch = await rpcCalls();
      for (const c of batch.calls) {
        record(`rpc:${c.method}`);
      }
      const solana = url.hostname.includes("solana");
      return rpcReply(batch, (m, p) => (solana ? solanaCall(model, m, p) : evmCall(model, m, p)));
    }
    // TRON node + indexer.
    if (/trongrid\.io|tatum\.io|nileex/.test(url.hostname)) {
      const sub = url.pathname.startsWith("/v1/accounts/")
        ? url.pathname.replace(/^\/v1\/accounts\/[^/]+/, "")
        : url.pathname;
      if (url.pathname.startsWith("/v1/accounts/")) {
        record(`tron:${sub}`);
        const out = tronIndexer(model, sub);
        if (out === undefined) {
          unstubbed.push(target);
        }
        return out === undefined ? json({}, 404) : json(out);
      }
      record(`tron:${sub}`);
      const reqBody = await body();
      const out = tronNode(model, sub, isObject(reqBody) ? reqBody : {}, tronAddress);
      if (out === undefined) {
        unstubbed.push(target);
      }
      return out === undefined ? json({}, 404) : json(out);
    }
    // Esplora (blockstream/emzy).
    if (/blockstream\.info|emzy\.de/.test(url.hostname)) {
      const path = url.pathname.replace(/^\/(api|testnet4\/api|signet\/api)/, "") || "/";
      record(`esplora:${method} ${path}`);
      const out = esplora(model, path, method);
      if (out === undefined) {
        unstubbed.push(target);
      }
      return out === undefined ? json({}, 404) : out instanceof Response ? out : json(out);
    }
    // Prices.
    if (target.startsWith(COINGECKO) || target.startsWith(DEFILLAMA)) {
      record(`prices:${method} ${url.pathname}${url.search.slice(0, 60)}`);
      const out = prices(url);
      if (out === undefined) {
        unstubbed.push(target);
      }
      return out === undefined ? json({}, 404) : json(out);
    }
    if (url.hostname === "login.blockstream.com") {
      record("blockstream:oauth");
      return json({ access_token: "stub", expires_in: 3600, token_type: "Bearer" });
    }
    // Engine-internal services (Spark wallet auth) — not a billed gateway upstream; refused
    // cleanly and listed separately, never in `unstubbed`.
    if (/lightspark\.com|spark\./.test(url.hostname)) {
      internal.push(target);
      return json({ error: "unimplemented" }, 501);
    }
    unstubbed.push(target);
    return json({ error: "unstubbed", url: target }, 404);
  };
  return { fetch: respond, calls, unstubbed, internal };
};

/**
 * The token-list source fetch for `buildTokenLists`: serves the committed fixtures for the three
 * source documents, everything else 404s (and is skipped by the build).
 */
// oxlint-disable-next-line typescript/require-await -- the fetch seam's signature is a promise
export const tokenListFetch: typeof globalThis.fetch = async (input) => {
  const target = String(input instanceof Request ? input.url : input);
  const file =
    target === "https://tokens.uniswap.org"
      ? "tokens-uniswap.json"
      : target === "https://pro-api.coingecko.com/api/v3/token_lists/hyperevm/all.json"
        ? "tokens-coingecko-hyperevm.json"
        : target === "https://api.jup.ag/tokens/v2/tag?query=verified"
          ? "tokens-jupiter.json"
          : undefined;
  if (file === undefined) {
    return json({ error: "unstubbed" }, 404);
  }
  return new Response(readFileSync(new URL(file, FIXTURES)), {
    headers: { "content-type": "application/json" },
  });
};
