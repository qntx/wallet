/* oxlint-disable no-await-in-loop, typescript/no-unsafe-type-assertion -- a manual recorder:
   sequential upstream calls, upstream bodies are stored as recorded */
/**
 * Records the real upstream answers the TRON gateway fixtures replay. Run `bun
 * scripts/record-tron.ts` from `apps/gateway`; it writes one `{status, body}` file per provider ×
 * request under `tests/fixtures/tron/<network>-<provider>/` and prints the provider/path pass-fail
 * matrix (the list that belongs in the change report).
 *
 * Coverage: every allow-listed node path on mainnet (TronGrid, Tatum, and PublicNode as an
 * unconfigured comparison) and Nile (TronGrid, NileEX, Tatum), plus the three TronGrid indexer GETs
 * on both networks. Trimming is limited to one documented rewrite: `transactions` is dropped from
 * block responses — the schemas never read it and full blocks are megabytes.
 *
 * BROADCAST_TX is a real TransferContract transaction built with the phase-1
 * `buildTronRawData`/`encodeTronTransaction`, a 65-byte garbage signature, and an expiration in the
 * past — the node's broadcast validates expiration before signature, so it deterministically
 * answers TRANSACTION_EXPIRATION_ERROR at any age. Either way it is a refusal the route relays.
 */
import { tronPathAllowed } from "@qntx/wallet-engine/gateway/contract";

declare const process: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: () => string;
};

declare const Bun: {
  readonly file: (path: string) => {
    readonly exists: () => Promise<boolean>;
    readonly json: () => Promise<unknown>;
  };
  readonly write: (path: string, contents: string) => Promise<unknown>;
};

const OUT = `${process.cwd()}/tests/fixtures/tron`;

// TRC-20 holder used for account/resource reads — a real USDT holder on mainnet, present on Nile.
const HOLDER = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";
// A generated address that has never been activated on either network.
const UNKNOWN = "TEWNZeMfMLjtcrbrZ1N6reGQts3a2MC2xp";
// Not a real transaction — exercises the not-found `{}` answers.
const BOGUS_TXID = "ab".repeat(32);
// `transfer(<the generated address>, 1000000)` calldata: selector + 20-byte EVM-form to + amount.
const TRANSFER_DATA =
  "a9059cbb" +
  "00000000000000000000000031c56137ff5ed70721fd412ed3a7600ecb3f137c" +
  "00000000000000000000000000000000000000000000000000000000000f4240";
// Garbage-signature transaction (see the header): a TransferContract of 1 sun, Nile ref block.
const BROADCAST_TX =
  "0a83010a026c47220840b592daeb9f345a40e08c87a1f7325a65080112610a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412300a1541e28b3cfd4e0e909077821478e9fcb86b84be786e12154131c56137ff5ed70721fd412ed3a7600ecb3f137c18017080b883a1f7321241" +
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type Provider = {
  readonly name: string;
  readonly url: string;
  /** Keyless rate: TronGrid ~3 rps, Tatum 5/min — a request every `ms`. */
  readonly ms: number;
  /** TronGrid is the only indexer (`/v1/accounts`) provider. */
  readonly indexer?: boolean;
};

type NetworkInput = {
  readonly caip2: string;
  readonly dir: string;
  /** TRC-20 contract used for the triggerconstantcontract fixture. */
  readonly token: string;
  readonly providers: ReadonlyArray<Provider>;
};

const MAINNET_PROVIDERS: ReadonlyArray<Provider> = [
  { name: "trongrid", url: "https://api.trongrid.io", ms: 1200, indexer: true },
  { name: "tatum", url: "https://tron-mainnet.gateway.tatum.io", ms: 15_000 },
  { name: "publicnode", url: "https://tron-rpc.publicnode.com", ms: 600 },
];
const NILE_PROVIDERS: ReadonlyArray<Provider> = [
  { name: "trongrid", url: "https://nile.trongrid.io", ms: 1200, indexer: true },
  { name: "nileex", url: "https://api.nileex.io", ms: 600 },
  { name: "tatum", url: "https://tron-nile.gateway.tatum.io", ms: 15_000 },
];

const NETWORKS: ReadonlyArray<NetworkInput> = [
  {
    caip2: "tron:728126428",
    dir: "mainnet",
    token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    providers: MAINNET_PROVIDERS,
  },
  {
    caip2: "tron:3448148188",
    dir: "nile",
    token: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
    providers: NILE_PROVIDERS,
  },
];

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const post = async (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const readJson = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { recordedText: text.slice(0, 500) };
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

type Request_ = {
  readonly name: string;
  readonly path: string;
  readonly body: (ctx: { readonly num: number; readonly txid: string }) => unknown;
};

const nodeRequests = (token: string): ReadonlyArray<Request_> => [
  { name: "nowblock-full", path: "/wallet/getnowblock", body: () => ({}) },
  { name: "nowblock-solidity", path: "/walletsolidity/getnowblock", body: () => ({}) },
  {
    name: "blockbynum-full",
    path: "/wallet/getblockbynum",
    body: ({ num }) => ({ num }),
  },
  {
    name: "blockbynum-solidity",
    path: "/walletsolidity/getblockbynum",
    body: ({ num }) => ({ num }),
  },
  {
    name: "account-holder",
    path: "/wallet/getaccount",
    body: () => ({ address: HOLDER, visible: true }),
  },
  {
    name: "account-unknown",
    path: "/wallet/getaccount",
    body: () => ({ address: UNKNOWN, visible: true }),
  },
  {
    name: "accountresource",
    path: "/wallet/getaccountresource",
    body: () => ({ address: HOLDER, visible: true }),
  },
  { name: "chainparameters", path: "/wallet/getchainparameters", body: () => ({}) },
  {
    name: "triggerconstantcontract",
    path: "/wallet/triggerconstantcontract",
    body: () => ({
      owner_address: HOLDER,
      contract_address: token,
      data: TRANSFER_DATA,
      visible: true,
    }),
  },
  {
    name: "broadcasthex",
    path: "/wallet/broadcasthex",
    body: () => ({ transaction: BROADCAST_TX }),
  },
  {
    name: "transactionbyid",
    path: "/wallet/gettransactionbyid",
    body: ({ txid }) => ({ value: txid }),
  },
  {
    name: "transactionbyid-bogus",
    path: "/wallet/gettransactionbyid",
    body: () => ({ value: BOGUS_TXID }),
  },
  {
    name: "transactioninfobyid",
    path: "/wallet/gettransactioninfobyid",
    body: ({ txid }) => ({ value: txid }),
  },
  {
    name: "transactioninfobyid-solidity",
    path: "/walletsolidity/gettransactioninfobyid",
    body: ({ txid }) => ({ value: txid }),
  },
  {
    name: "availableunfreezecount",
    path: "/wallet/getavailableunfreezecount",
    body: () => ({ owner_address: HOLDER, visible: true }),
  },
  {
    name: "candelegatedmaxsize-bandwidth",
    path: "/wallet/getcandelegatedmaxsize",
    body: () => ({ owner_address: HOLDER, type: 0, visible: true }),
  },
  {
    name: "candelegatedmaxsize-energy",
    path: "/wallet/getcandelegatedmaxsize",
    body: () => ({ owner_address: HOLDER, type: 1, visible: true }),
  },
  {
    name: "delegatedresourcev2",
    path: "/wallet/getdelegatedresourcev2",
    body: () => ({ fromAddress: HOLDER, toAddress: UNKNOWN, visible: true }),
  },
  {
    name: "getreward",
    path: "/wallet/getReward",
    body: () => ({ address: HOLDER, visible: true }),
  },
  { name: "listwitnesses", path: "/wallet/listwitnesses", body: () => ({}) },
  {
    // TRC-10 id 1002000 (BTT) — the asset metadata read for balances.
    name: "assetissuebyid",
    path: "/wallet/getassetissuebyid",
    body: () => ({ value: 1002000 }),
  },
];

/** The documented trim: `transactions` is dropped from block responses (they are megabytes). */
const trim = (path: string, body: unknown): unknown => {
  if (path.includes("block") && isObject(body) && "transactions" in body) {
    const { transactions: _dropped, ...rest } = body;
    return rest;
  }
  return body;
};

const write = async (dir: string, name: string, entry: unknown): Promise<void> => {
  await Bun.write(`${OUT}/${dir}/${name}.json`, `${JSON.stringify(entry, null, 2)}\n`);
};

/** A recorded 200 answer stays — a re-run only fills gaps and replaces failed entries. */
const recorded = async (dir: string, name: string): Promise<boolean> => {
  const file = Bun.file(`${OUT}/${dir}/${name}.json`);
  if (!(await file.exists())) {
    return false;
  }
  const entry: unknown = await file.json();
  return isObject(entry) && entry.status === 200;
};

const failures: string[] = [];

/** A recent solid head number and a txid from a recent block on this provider. */
const context = async (provider: Provider): Promise<{ num: number; txid: string }> => {
  const head = await post(`${provider.url}/walletsolidity/getnowblock`, {});
  const headBody: unknown = await head.json();
  const num = isObject(headBody)
    ? ((
        (headBody.block_header as Record<string, unknown> | undefined)?.raw_data as
          | Record<string, unknown>
          | undefined
      )?.number as number | undefined)
    : undefined;
  if (num === undefined) {
    throw new Error(`no solid head from ${provider.url}`);
  }
  for (let i = 0; i < 30; i += 1) {
    await sleep(provider.ms);
    const res = await post(`${provider.url}/walletsolidity/getblockbynum`, { num: num - i });
    const body: unknown = await res.json();
    const txs = isObject(body) ? body.transactions : undefined;
    if (Array.isArray(txs) && txs.length > 0) {
      const first = txs[0] as { txID?: string };
      if (typeof first.txID === "string") {
        return { num, txid: first.txID };
      }
    }
  }
  throw new Error(`no transaction in the last 30 solid blocks on ${provider.url}`);
};

for (const network of NETWORKS) {
  for (const provider of network.providers) {
    const dir = `${network.dir}-${provider.name}`;
    let ctx: { num: number; txid: string };
    try {
      ctx = await context(provider);
      console.log(`${dir}: num ${ctx.num} txid ${ctx.txid}`);
    } catch (error) {
      console.log(`${dir}: context failed — ${String(error)}`);
      failures.push(`${dir}: ALL (context)`);
      continue;
    }
    await sleep(provider.ms);
    for (const request of nodeRequests(network.token)) {
      if (!tronPathAllowed(request.path)) {
        throw new Error(`recorder path ${request.path} is not in the contract allow-list`);
      }
      if (await recorded(dir, request.name)) {
        continue;
      }
      try {
        const res = await post(`${provider.url}${request.path}`, request.body(ctx));
        const body = trim(request.path, await readJson(res));
        await write(dir, request.name, { status: res.status, body });
        if (res.status !== 200) {
          failures.push(`${dir}: ${request.name} status ${res.status}`);
        }
      } catch (error) {
        failures.push(`${dir}: ${request.name} ${String(error)}`);
      }
      await sleep(provider.ms);
    }
  }
}

// TronGrid indexer GETs — the forms the gateway translates indexer POSTs into.
for (const network of NETWORKS) {
  const provider = network.providers.find((p) => p.indexer === true);
  if (provider === undefined) {
    continue;
  }
  const dir = `${network.dir}-${provider.name}`;
  const gets: ReadonlyArray<[string, string]> = [
    [
      "v1-accounts-transactions",
      `/v1/accounts/${HOLDER}/transactions?only_confirmed=true&limit=10`,
    ],
    [
      "v1-accounts-transactions-trc20",
      `/v1/accounts/${HOLDER}/transactions/trc20?only_confirmed=true&limit=10`,
    ],
    ["v1-accounts-account", `/v1/accounts/${HOLDER}`],
  ];
  for (const [name, path] of gets) {
    if (await recorded(dir, name)) {
      continue;
    }
    try {
      const res = await fetch(`${provider.url}${path}`);
      const body = await readJson(res);
      await write(dir, name, { status: res.status, body });
      if (res.status !== 200) {
        failures.push(`${dir}: ${name} status ${res.status}`);
      }
    } catch (error) {
      failures.push(`${dir}: ${name} ${String(error)}`);
    }
    await sleep(provider.ms);
  }
}

/**
 * History fixtures: the holder's real paged indexer feeds and the node evidence the stream
 * cross-checks against. `history-transactions-N`/`history-trc20-N` are consecutive fingerprint
 * pages; `history-tx-<txid>`/`history-info-<txid>` are
 * `gettransactionbyid`/`gettransactioninfobyid` for every transfer txid in them (a few extra
 * tx-feed pages hunt a TransferAssetContract row).
 */
type PageBody = {
  readonly data?: ReadonlyArray<Record<string, unknown>>;
  readonly meta?: { readonly fingerprint?: string };
};

const pageTxids = (body: unknown): ReadonlyArray<{ txid: string; kind: string }> => {
  const out: Array<{ txid: string; kind: string }> = [];
  for (const row of (body as PageBody | undefined)?.data ?? []) {
    if (typeof row.txID === "string") {
      const contracts = (row.raw_data as { contract?: Array<{ type?: string }> } | undefined)
        ?.contract;
      const type = contracts?.[0]?.type;
      if (type === "TransferContract" || type === "TransferAssetContract") {
        out.push({ txid: row.txID, kind: type });
      }
    }
    if (typeof row.transaction_id === "string") {
      out.push({ txid: row.transaction_id, kind: "trc20" });
    }
  }
  return out;
};

const fingerprintOf = (body: unknown): string | undefined =>
  (body as PageBody | undefined)?.meta?.fingerprint;

const recordedBody = async (dir: string, name: string): Promise<unknown> => {
  const file = Bun.file(`${OUT}/${dir}/${name}.json`);
  return (await file.exists()) ? file.json() : undefined;
};

for (const network of NETWORKS) {
  const provider = network.providers.find((p) => p.indexer === true);
  if (provider === undefined) {
    continue;
  }
  const dir = `${network.dir}-${provider.name}`;
  const feeds: ReadonlyArray<{ name: string; feed: string; pages: number }> = [
    { name: "history-transactions", feed: "transactions", pages: 4 },
    { name: "history-trc20", feed: "transactions/trc20", pages: 2 },
  ];
  const txids = new Map<string, string>();
  for (const { name, feed, pages } of feeds) {
    let fingerprint: string | undefined;
    for (let i = 0; i < pages; i += 1) {
      const fixture = `${name}-${i}`;
      const query = `only_confirmed=true&limit=25${fingerprint === undefined ? "" : `&fingerprint=${fingerprint}`}`;
      if (!(await recorded(dir, fixture))) {
        try {
          const res = await fetch(`${provider.url}/v1/accounts/${HOLDER}/${feed}?${query}`);
          const body = await readJson(res);
          await write(dir, fixture, { status: res.status, body });
          if (res.status !== 200) {
            failures.push(`${dir}: ${fixture} status ${res.status}`);
          }
        } catch (error) {
          failures.push(`${dir}: ${fixture} ${String(error)}`);
        }
        await sleep(provider.ms);
      }
      const entry = await recordedBody(dir, fixture);
      const body = isObject(entry) ? entry.body : undefined;
      for (const { txid, kind } of pageTxids(body)) {
        txids.set(txid, kind);
      }
      fingerprint = fingerprintOf(body);
      if (fingerprint === undefined) {
        break;
      }
    }
  }
  // Node evidence for a few transfer claims of each kind — the bodies the stream cross-checks.
  const perKind = new Map<string, number>();
  for (const [txid, kind] of txids) {
    const taken = perKind.get(kind) ?? 0;
    if (taken >= 4) {
      continue;
    }
    perKind.set(kind, taken + 1);
    for (const [prefix, path] of [
      ["history-tx", "/wallet/gettransactionbyid"],
      ["history-info", "/wallet/gettransactioninfobyid"],
    ] as const) {
      const fixture = `${prefix}-${txid}`;
      if (await recorded(dir, fixture)) {
        continue;
      }
      try {
        const res = await post(`${provider.url}${path}`, { value: txid });
        const body = await readJson(res);
        await write(dir, fixture, { status: res.status, body });
        if (res.status !== 200) {
          failures.push(`${dir}: ${fixture} status ${res.status}`);
        }
      } catch (error) {
        failures.push(`${dir}: ${fixture} ${String(error)}`);
      }
      await sleep(provider.ms);
    }
  }
  const kinds = [...txids.values()];
  console.log(
    `${dir}: history feeds — ${kinds.filter((k) => k === "TransferContract").length} TRX, ` +
      `${kinds.filter((k) => k === "TransferAssetContract").length} TRC-10, ` +
      `${kinds.filter((k) => k === "trc20").length} TRC-20 txids`,
  );
}

if (failures.length > 0) {
  console.log(`\nprovider/path failures (${failures.length}):`);
  for (const failure of failures) {
    console.log(`  ${failure}`);
  }
} else {
  console.log("\nall provider/path combinations answered");
}
