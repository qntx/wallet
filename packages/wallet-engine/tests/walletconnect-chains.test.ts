/* oxlint-disable vitest/no-conditional-in-test -- the relay helpers narrow results for assertions */
/**
 * The solana and bip122 namespace rows end to end over the in-process relay: sessions whose
 * namespaces advertise only each chain's dApp-facing account, requests translated into the shared
 * Wallet Standard handlers and the `send` pipeline, `bip122_addressesChanged` on approval and on a
 * group switch, and the codec/param validation that turns malformed input into -32602.
 *
 * The relay support module installs the WebSocket/fetch stubs the SDK captures at module load, so
 * it MUST be the first import in this file.
 */
import { randomBytes } from "node:crypto";

import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, base64, hex } from "@scure/base";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { NETWORK } from "@scure/btc-signer/utils.js";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import type { SignClient } from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { verifyBitcoinMessage, verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import { verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { scripthash } from "../src/chains/bitcoin-scan.ts";
import type { ConnectionSession } from "../src/connect/controller.ts";
import { createWalletEngine } from "../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import type {
  createWalletConnectClient as CreateClient,
  WalletConnect,
  WalletConnectProposal,
} from "../src/walletconnect/client.ts";
import { approval } from "./approval.ts";
import { b64 } from "./phishing-helpers.ts";
import { manualTimers } from "./support/timers.ts";
import { memoryWalletConnectStorage, walletConnectRelay } from "./support/walletconnect-relay.ts";

// SDK modules capture globalThis.WebSocket at evaluation, so they are dynamically imported inside
// the rigs — never at module load — while the relay stub installs at this module's own evaluation.
const loadClient = async (): Promise<typeof CreateClient> => {
  const module = await import("../src/walletconnect/client.ts");
  return module.createWalletConnectClient;
};

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const PW = { kind: "password" as const, password: PASSWORD };
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SECOND = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const GATEWAY = "https://gateway.test";
const SOL_MAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_DEV = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BTC_MAIN = "bip122:000000000019d6689c085ae165831e93";
const BTC_GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const DAPP_URL = "https://dapp.example";
const WALLET_META = {
  name: "qntx wallet",
  description: "the test wallet",
  url: "https://wallet.example",
  icons: [],
};
const DAPP_META = { name: "test dapp", description: "dapp", url: DAPP_URL, icons: [] };
// The test mnemonic's first bip84/bip86 receive addresses — the session's two purposes.
const BIP84_FIRST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const BIP86_FIRST = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const RECIP = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

const SOL_METHODS = [
  "solana_signMessage",
  "solana_signTransaction",
  "solana_signAllTransactions",
  "solana_signAndSendTransaction",
];
const BTC_METHODS = ["getAccountAddresses", "signMessage", "signPsbt", "sendTransfer"];
const BTC_EVENTS = ["accountsChanged", "chainChanged", "bip122_addressesChanged"];
const USER_REJECTED = 5000;

/** Raw previous transactions the fake esplora serves by txid — registered per fixture below. */
const PREVS = new Map<string, Uint8Array>();
/** The raw hex the esplora was asked to broadcast, in order. */
const broadcasts: string[] = [];
const acceptedTxids = new Set<string>();
/** The prevout the fake esplora reports against the bip84 address — set by `fundPrev`. */
let funded: { txid: string; vout: number; value: number } | undefined;

/** A prevout paying the wallet's bip84 address — the send the tests fund themselves with. */
const fundPrev = (to: string, value: bigint): void => {
  const prev = new Transaction({ version: 2 });
  prev.addInput({ txid: new Uint8Array(32).fill(7), index: 0, sequence: 0xffffffff });
  prev.addOutput({ script: scriptOf(to), amount: value });
  PREVS.set(prev.id, prev.toBytes(true, false));
  funded = { txid: prev.id, vout: 0, value: Number(value) };
};

const scriptOf = (address: string): Uint8Array =>
  OutScript.encode(Address(NETWORK).decode(address));

const solanaWires: Uint8Array[] = [];
const SOL_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const RPC_SIG = base58.encode(new Uint8Array(64).fill(0x5a));

const solanaRpc = (method: string, params: unknown[]): unknown => {
  if (method === "getGenesisHash") {
    return SOL_GENESIS;
  }
  if (method === "getBlockHeight") {
    return 500;
  }
  if (method === "getEpochInfo") {
    return { absoluteSlot: 700, blockHeight: 500 };
  }
  if (method === "getSignatureStatuses") {
    const sigs = Array.isArray(params[0]) ? params[0] : [];
    return { context: { slot: 1 }, value: sigs.map(() => null) };
  }
  if (method === "sendTransaction") {
    return RPC_SIG;
  }
  throw new Error(`no solana rpc answer for ${method}`);
};

const OUR_BIP84_HASH = scripthash(BIP84_FIRST, NETWORK);

async function rig() {
  const timers = manualTimers();
  const wallet = await createNodeWallet({
    verifyEvent,
    passkey: {
      rpId: "qntx.test",
      rpName: "qntx",
      walletSalt: "qntx/wallet",
      backupSalt: "qntx/backup",
      vaultSalt: "qntx/vault",
    },
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(randomBytes(32)),
    kernelUrl: KERNEL_URL,
  });
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const durableStore = (): EngineStore => {
    const store = createMemoryEngineStore(backing);
    return { collection: (name) => store.collection(name), close: async () => Promise.resolve() };
  };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/risk/lists/phishing`) {
      return Response.json({ kind: "snapshot", version: 1, deny: b64([]), allow: b64([]) });
    }
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: [] });
    }
    if (url === "https://solana.invalid" || url === "https://solanadev.invalid") {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      if (body.method === "sendTransaction") {
        solanaWires.push(Uint8Array.from(Buffer.from(String(body.params[0]), "base64")));
      }
      try {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: solanaRpc(body.method, body.params),
        });
      } catch (error) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32_601, message: (error as Error).message },
        });
      }
    }
    if (url.startsWith("https://esplora.invalid")) {
      const path = url.slice("https://esplora.invalid".length);
      if (init?.method === "POST") {
        broadcasts.push(String(init.body));
        const txid = Transaction.fromRaw(hex.decode(String(init.body))).id;
        acceptedTxids.add(txid);
        return new Response(txid);
      }
      const hexMatch = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path);
      if (hexMatch !== null) {
        return new Response(Buffer.from(PREVS.get(hexMatch[1] ?? "") ?? []).toString("hex"));
      }
      const statusMatch = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path);
      if (statusMatch !== null) {
        return statusMatch[1] === funded?.txid
          ? Response.json({ confirmed: true, block_height: 1 })
          : acceptedTxids.has(statusMatch[1] ?? "")
            ? Response.json({ confirmed: false })
            : new Response("Transaction not found", { status: 404 });
      }
      const outspendsMatch = /^\/tx\/([0-9a-f]{64})\/outspends$/.exec(path);
      if (outspendsMatch !== null) {
        return Response.json([{ spent: false }, { spent: false }]);
      }
      if (path === "/block-height/0") {
        return new Response(BTC_GENESIS);
      }
      if (path === "/blocks/tip/height") {
        return new Response("100");
      }
      if (path === "/fee-estimates") {
        return Response.json({ "1": 10, "3": 5, "6": 2, "144": 1 });
      }
      const txsMatch = /^\/scripthash\/([0-9a-f]{64})\/txs$/.exec(path);
      if (txsMatch !== null) {
        return Response.json(
          txsMatch[1] === OUR_BIP84_HASH && funded !== undefined ? [{ txid: funded.txid }] : [],
        );
      }
      const utxoMatch = /^\/scripthash\/([0-9a-f]{64})\/utxo$/.exec(path);
      if (utxoMatch !== null) {
        return Response.json(
          utxoMatch[1] === OUR_BIP84_HASH && funded !== undefined
            ? [
                {
                  txid: funded.txid,
                  vout: funded.vout,
                  value: funded.value,
                  status: { confirmed: true, block_height: 1 },
                },
              ]
            : [],
        );
      }
      return Response.json([]);
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  const engine = createWalletEngine({
    setTimer: timers.setTimer,
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: fetchImpl,
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: () => undefined },
    showCallsStatus: () => undefined,
    openStore: async () => Promise.resolve(durableStore()),
    rpc: {
      [SOL_MAIN]: ["https://solana.invalid"],
      [SOL_DEV]: ["https://solanadev.invalid"],
      [BTC_MAIN]: ["https://esplora.invalid"],
    },
    gateway: { url: GATEWAY },
  });
  const info = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: PW,
  });
  await until(() => engine.accounts.getState().selected !== null);
  const storage = memoryWalletConnectStorage();
  const createWalletConnectClient = await loadClient();
  const client = await createWalletConnectClient({
    projectId: "test",
    metadata: WALLET_META,
    storage,
    relayUrl: "wss://fake.relay",
    wallet,
    engine,
    now: () => Date.now(),
    logger: { warn: () => undefined },
  });
  return {
    timers,
    wallet,
    engine,
    wc: client.walletConnect,
    core: client.core,
    kit: client.kit,
    storage,
    walletId: info.walletId,
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

async function until(read: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error("until() timed out");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const soleProposal = (wc: WalletConnect): WalletConnectProposal => {
  const [proposal] = Object.values(wc.getState().proposals);
  if (proposal === undefined) {
    throw new Error("no proposal in state");
  }
  return proposal;
};

type Dapp = Awaited<ReturnType<typeof SignClient.init>>;

async function dapp(metadata = DAPP_META): Promise<Dapp> {
  const { SignClient } = await import("@walletconnect/sign-client");
  return SignClient.init({
    projectId: "test",
    relayUrl: "wss://fake.relay",
    storage: memoryWalletConnectStorage() as never,
    customStoragePrefix: "dapp",
    metadata,
    logger: "silent",
    telemetryEnabled: false,
  });
}

type Namespaces = Parameters<Dapp["connect"]>[0];

/** Connect → pair → proposal in state; the dApp's `approval` is left for the caller to settle. */
async function proposed(
  r: Rig,
  client: Dapp,
  namespaces: Namespaces,
): Promise<{ proposal: WalletConnectProposal; approval: () => Promise<SessionTypes.Struct> }> {
  const { uri, approval } = await client.connect(namespaces);
  if (uri === undefined) {
    throw new Error("connect produced no uri");
  }
  await r.wc.pair(uri);
  await until(() => Object.keys(r.wc.getState().proposals).length === 1);
  const settled = approval();
  settled.catch(() => undefined);
  return { proposal: soleProposal(r.wc), approval: async () => settled };
}

async function established(
  r: Rig,
  client: Dapp,
  namespaces: Namespaces,
  grant?: ReadonlyArray<string>,
): Promise<{
  proposal: WalletConnectProposal;
  session: ConnectionSession;
  live: SessionTypes.Struct;
}> {
  const { proposal, approval } = await proposed(r, client, namespaces);
  const session = await r.wc.approve(proposal.id, {
    networks: grant ?? [...proposal.networks],
  });
  const live = await approval();
  return { proposal, session, live };
}

/** The session account a call binds to — the CAIP-10 tail. */
const accountOf = (session: ConnectionSession, network: string): string => {
  const scope = session.scopes[network];
  const [account] = scope?.accounts ?? [];
  if (account === undefined) {
    throw new Error(`no account for ${network}`);
  }
  return account.split(":").pop() ?? "";
};

const awaiting = (r: Rig) =>
  Object.values(r.engine.requests.getState().requests).filter(
    (request) => request.stage === "awaiting-approval",
  );

const openRequest = async (r: Rig) => {
  await until(() => awaiting(r).length === 1);
  const [request] = awaiting(r);
  if (request === undefined) {
    throw new Error("no awaiting request");
  }
  return request;
};

type SettledRequest = { value: unknown } | { error: { code?: number; message?: string } };

const call = async (
  r: Rig,
  client: Dapp,
  live: SessionTypes.Struct,
  method: string,
  params: unknown,
  chainId: string,
): Promise<{
  settled: Promise<SettledRequest>;
  approve: (kind: "send" | "solana-sign" | "bitcoin-sign") => Promise<unknown>;
  reject: () => void;
  requestId: () => string;
}> => {
  const settled = client
    .request({ topic: live.topic, chainId, request: { method, params } })
    .then((value): SettledRequest => ({ value }))
    .catch((error: unknown): SettledRequest => ({ error: error as { code?: number } }));
  const request = await openRequest(r);
  return {
    settled,
    requestId: () => request.id,
    approve: async (kind) => {
      const options = approval(request, PW);
      return kind === "send"
        ? r.engine.requests.approve(request.id, "send", options)
        : kind === "solana-sign"
          ? r.engine.requests.approve(request.id, "solana-sign", options)
          : r.engine.requests.approve(request.id, "bitcoin-sign", options);
    },
    reject: () => r.engine.requests.reject(request.id),
  };
};

/** Raw `wc_sessionRequest` publish, bypassing the dApp SignClient's own validation. */
const sendRaw = async (
  client: Dapp,
  topic: string,
  id: number,
  method: string,
  params: unknown,
  chainId: string,
): Promise<void> => {
  const message = await client.core.crypto.encode(topic, {
    id,
    jsonrpc: "2.0",
    method: "wc_sessionRequest",
    params: { request: { method, params }, chainId },
  });
  await client.core.relayer.publish(topic, message, { tag: 1108, ttl: 300 });
};

/** JSON-RPC answers published on a session topic, decoded through the dApp's session key. */
const responseFor = async (
  client: Dapp,
  topic: string,
  id: number,
  ms = 10_000,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> => {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const raw of walletConnectRelay.messagesOn(topic)) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- decodes land in order
        const payload = (await client.core.crypto.decode(topic, raw)) as {
          id?: number;
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (payload.id === id && ("result" in payload || "error" in payload)) {
          return payload;
        }
      } catch {
        // Proposal/settlement envelopes decode differently — only answers matter here.
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no response for request ${id}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const value = (settled: SettledRequest): unknown => {
  if ("error" in settled) {
    throw new Error(`request failed: ${JSON.stringify(settled.error)}`);
  }
  return settled.value;
};

const transferIx = (from: string, to: string, lamports: bigint): Instruction => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data,
  };
};

const DEST = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

/** An unsigned wire transaction the wallet's solana account is the fee payer of. */
const solTx = (feePayer: string): Uint8Array => {
  const message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1000n },
    setTransactionMessageFeePayer(
      address(feePayer),
      createTransactionMessage({ version: "legacy" }),
    ),
  );
  const withIx = appendTransactionMessageInstruction(
    transferIx(feePayer, DEST, 1000n),
    message as never,
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(withIx)));
};

/** A PSBT spending one prevout of `from` (a wallet address) to `to`, as a dApp builds it. */
const dappPsbt = (opts: {
  from: string;
  to: string;
  value: bigint;
  sighash?: number;
}): Uint8Array => {
  const prev = new Transaction({ version: 2 });
  prev.addInput({
    txid: new Uint8Array(32).fill(9),
    index: 0,
    sequence: 0xffffffff,
  });
  prev.addOutput({ script: scriptOf(opts.from), amount: opts.value });
  PREVS.set(prev.id, prev.toBytes(true, false));
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: scriptOf(opts.from), amount: opts.value },
    ...(opts.sighash === undefined ? {} : { sighashType: opts.sighash }),
  });
  tx.addOutput({ script: scriptOf(opts.to), amount: opts.value - 1000n });
  return tx.toPSBT(0);
};

const solanaNamespaces = (
  chains: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): Namespaces => ({
  optionalNamespaces: {
    solana: {
      chains: [...chains, ...optional],
      methods: [...SOL_METHODS],
      events: ["accountsChanged", "chainChanged"],
    },
  },
});

const bip122Namespaces = (
  methods: ReadonlyArray<string> = BTC_METHODS,
  events: ReadonlyArray<string> = BTC_EVENTS,
): Namespaces => ({
  optionalNamespaces: {
    bip122: { chains: [BTC_MAIN], methods: [...methods], events: [...events] },
  },
});

describe("walletconnect solana", () => {
  it(
    "establishes a session whose solana namespace carries the group's account",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(
        r,
        client,
        solanaNamespaces([SOL_MAIN], [SOL_DEV]),
        [SOL_MAIN],
      );
      const account = accountOf(session, SOL_MAIN);
      expect(live.namespaces["solana"]?.accounts).toStrictEqual([`${SOL_MAIN}:${account}`]);
      expect(live.namespaces["solana"]?.chains).toStrictEqual([SOL_MAIN]);
      expect(live.namespaces["solana"]?.methods).toStrictEqual(SOL_METHODS);
      await r.wc.dispose();
    },
  );

  it(
    "signs a message whose signature verifies for the session account",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client, solanaNamespaces([SOL_MAIN]));
      const account = accountOf(session, SOL_MAIN);
      const text = utf8ToBytes("hello solana");
      const sign = await call(
        r,
        client,
        live,
        "solana_signMessage",
        {
          message: base58.encode(text),
          pubkey: account,
        },
        SOL_MAIN,
      );
      await sign.approve("solana-sign");
      const result = value(await sign.settled) as { signature: string };
      expect(verifySolanaSignature(text, base58.decode(result.signature), account)).toBe(true);
      await r.wc.dispose();
    },
  );

  it(
    "signs a transaction and returns our slot signature plus the signed wire",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client, solanaNamespaces([SOL_MAIN]));
      const account = accountOf(session, SOL_MAIN);
      const tx = solTx(account);
      const sign = await call(
        r,
        client,
        live,
        "solana_signTransaction",
        {
          transaction: base64.encode(tx),
          pubkey: account,
        },
        SOL_MAIN,
      );
      await sign.approve("solana-sign");
      const result = value(await sign.settled) as { signature: string; transaction: string };
      const decoded = getTransactionDecoder().decode(base64.decode(result.transaction));
      const ours = decoded.signatures[address(account)];
      expect(ours === null || ours === undefined).toBe(false);
      expect(base58.encode(new Uint8Array(ours ?? []))).toBe(result.signature);
      expect(
        verifySolanaSignature(
          new Uint8Array(decoded.messageBytes),
          new Uint8Array(ours ?? []),
          account,
        ),
      ).toBe(true);
      await r.wc.dispose();
    },
  );

  it(
    "signs every transaction of a solana_signAllTransactions call in order",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client, solanaNamespaces([SOL_MAIN]));
      const account = accountOf(session, SOL_MAIN);
      const txs = [solTx(account), solTx(account)];
      const sign = await call(
        r,
        client,
        live,
        "solana_signAllTransactions",
        {
          transactions: txs.map((tx) => base64.encode(tx)),
        },
        SOL_MAIN,
      );
      await sign.approve("solana-sign");
      const result = value(await sign.settled) as { transactions: string[] };
      expect(result.transactions).toHaveLength(2);
      for (const [index, encoded] of result.transactions.entries()) {
        const decoded = getTransactionDecoder().decode(base64.decode(encoded));
        expect(
          decoded.signatures[address(account)] === null ||
            decoded.signatures[address(account)] === undefined,
        ).toBe(false);
        // Order is preserved: the message bytes match the input in the same position.
        expect(base64.encode(new Uint8Array(decoded.messageBytes))).toBe(
          base64.encode(
            new Uint8Array(
              getTransactionDecoder().decode(txs[index] ?? new Uint8Array()).messageBytes,
            ),
          ),
        );
      }
      await r.wc.dispose();
    },
  );

  it(
    "broadcasts a sign-and-send and returns the wire's signature",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client, solanaNamespaces([SOL_MAIN]));
      const account = accountOf(session, SOL_MAIN);
      const sign = await call(
        r,
        client,
        live,
        "solana_signAndSendTransaction",
        {
          transaction: base64.encode(solTx(account)),
          pubkey: account,
        },
        SOL_MAIN,
      );
      await sign.approve("solana-sign");
      const result = value(await sign.settled) as { signature: string };
      const [sent] = solanaWires;
      if (sent === undefined) {
        throw new Error("no transaction reached the RPC endpoint");
      }
      expect(result.signature).toBe(
        getSignatureFromTransaction(getTransactionDecoder().decode(sent)),
      );
      await r.wc.dispose();
    },
  );

  it(
    "maps a user rejection to code 5000 and refuses malformed params with -32602",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client, solanaNamespaces([SOL_MAIN]));
      const account = accountOf(session, SOL_MAIN);
      const sign = await call(
        r,
        client,
        live,
        "solana_signMessage",
        {
          message: base58.encode(utf8ToBytes("reject me")),
          pubkey: account,
        },
        SOL_MAIN,
      );
      sign.reject();
      await expect(sign.settled).resolves.toMatchObject({ error: { code: USER_REJECTED } });

      const bad58 = client
        .request({
          topic: live.topic,
          chainId: SOL_MAIN,
          request: {
            method: "solana_signMessage",
            params: { message: "0xnot-base58!!!", pubkey: account },
          },
        })
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({ error: error as { code?: number } }));
      await expect(bad58).resolves.toMatchObject({ error: { code: -32_602 } });

      const empty = client
        .request({
          topic: live.topic,
          chainId: SOL_MAIN,
          request: { method: "solana_signAllTransactions", params: { transactions: [] } },
        })
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({ error: error as { code?: number } }));
      await expect(empty).resolves.toMatchObject({ error: { code: -32_602 } });
      await r.wc.dispose();
    },
  );

  it(
    "refuses a foreign pubkey with 4100 and a chain outside the grant with WalletKit's code 5",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(
        r,
        client,
        solanaNamespaces([SOL_MAIN], [SOL_DEV]),
        [SOL_MAIN],
      );
      const account = accountOf(session, SOL_MAIN);
      const foreign = client
        .request({
          topic: live.topic,
          chainId: SOL_MAIN,
          request: {
            method: "solana_signMessage",
            params: { message: base58.encode(utf8ToBytes("x")), pubkey: DEST },
          },
        })
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({ error: error as { code?: number } }));
      await expect(foreign).resolves.toMatchObject({ error: { code: 4100 } });

      // Granted only mainnet: a devnet request never reaches the pipeline — WalletKit's own 5.
      const id = 9001;
      await sendRaw(
        client,
        live.topic,
        id,
        "solana_signMessage",
        {
          message: base58.encode(utf8ToBytes("y")),
          pubkey: account,
        },
        SOL_DEV,
      );
      // WalletKit's engine rejects it on the wire before our pipeline sees it (the decoded
      // error is a JSON-RPC error class — `error` is present, its fields are not enumerable).
      const answer = await responseFor(client, live.topic, id);
      expect(answer.error).toBeDefined();
      expect(awaiting(r)).toHaveLength(0);
      await r.wc.dispose();
    },
  );
});

describe("walletconnect bip122", () => {
  it(
    "establishes a session advertising only the payment account",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client, bip122Namespaces());
      expect(live.namespaces["bip122"]?.accounts).toStrictEqual([`${BTC_MAIN}:${BIP84_FIRST}`]);
      expect(live.namespaces["bip122"]?.methods).toStrictEqual(BTC_METHODS);
      await r.wc.dispose();
    },
  );

  it(
    "emits bip122_addressesChanged after approval and again on a group switch",
    { timeout: 150_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const events: Array<{ name: string; chainId: string; data: unknown }> = [];
      client.on("session_event", (event) => {
        events.push({
          name: event.params.event.name,
          chainId: event.params.chainId,
          data: event.params.event.data,
        });
      });
      await established(r, client, bip122Namespaces());
      await until(() =>
        events.some((e) => e.name === "bip122_addressesChanged" && e.chainId === BTC_MAIN),
      );
      const first = events.filter((e) => e.name === "bip122_addressesChanged");
      expect(first).toHaveLength(1);
      expect(first[0]?.data).toMatchObject([
        { address: BIP84_FIRST, intention: "payment" },
        { address: BIP86_FIRST, intention: "ordinal" },
      ]);
      const other = await r.wallet.wallets.importMnemonic({ mnemonic: SECOND });
      r.engine.accounts.select(other.walletId, 0);
      await until(() => events.filter((e) => e.name === "bip122_addressesChanged").length > 1);
      const second = events.at(-1)?.data as ReadonlyArray<{ address: string }> | undefined;
      expect(second?.[0]?.address).not.toBe(BIP84_FIRST);
      await r.wc.dispose();
    },
  );

  it(
    "answers getAccountAddresses for both purposes and filters by intention",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client, bip122Namespaces());
      const both: ReadonlyArray<{ address: string; publicKey: string; intention: string }> =
        await client.request({
          topic: live.topic,
          chainId: BTC_MAIN,
          request: { method: "getAccountAddresses", params: { account: BIP84_FIRST } },
        });
      expect(both.map((a) => a.intention)).toStrictEqual(["payment", "ordinal"]);
      expect(both.map((a) => a.address)).toStrictEqual([BIP84_FIRST, BIP86_FIRST]);
      expect(both[0]?.publicKey).toMatch(/^[0-9a-f]{66}$/);
      expect(both[1]?.publicKey).toMatch(/^[0-9a-f]{64}$/);

      const ordinal: ReadonlyArray<{ intention: string; address: string }> = await client.request({
        topic: live.topic,
        chainId: BTC_MAIN,
        request: {
          method: "getAccountAddresses",
          params: { account: BIP84_FIRST, intentions: ["ordinal"] },
        },
      });
      expect(ordinal).toStrictEqual([
        {
          address: BIP86_FIRST,
          publicKey: expect.stringMatching(/^[0-9a-f]{64}$/),
          intention: "ordinal",
        },
      ]);

      const unknown = client
        .request({
          topic: live.topic,
          chainId: BTC_MAIN,
          request: {
            method: "getAccountAddresses",
            params: { account: BIP84_FIRST, intentions: ["satoshi"] },
          },
        })
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({ error: error as { code?: number } }));
      await expect(unknown).resolves.toMatchObject({ error: { code: -32_602 } });
      await r.wc.dispose();
    },
  );

  it(
    "signs a BIP-322 message the verifier accepts and refuses the ecdsa default with 4200",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client, bip122Namespaces());
      const sign = await call(
        r,
        client,
        live,
        "signMessage",
        { account: BIP84_FIRST, message: "hello bitcoin", protocol: "bip322" },
        BTC_MAIN,
      );
      await sign.approve("bitcoin-sign");
      const result = value(await sign.settled) as { address: string; signature: string };
      expect(result.address).toBe(BIP84_FIRST);
      expect(
        verifyBitcoinMessage(
          BIP84_FIRST,
          "hello bitcoin",
          `smp${Buffer.from(hex.decode(result.signature)).toString("base64")}`,
          BTC_MAIN,
        ),
      ).toBe(true);

      // The spec's default is ecdsa — the engine only signs BIP-322, so absent is refused too.
      const ecdsa = client
        .request({
          topic: live.topic,
          chainId: BTC_MAIN,
          request: { method: "signMessage", params: { account: BIP84_FIRST, message: "x" } },
        })
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({ error: error as { code?: number } }));
      await expect(ecdsa).resolves.toMatchObject({ error: { code: 4200 } });
      await r.wc.dispose();
    },
  );

  it(
    "signs a PSBT (and broadcasts it) with the wallet's verification and txid",
    { timeout: 150_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client, bip122Namespaces());
      const psbt = dappPsbt({ from: BIP84_FIRST, to: RECIP, value: 100_000n });
      const sign = await call(
        r,
        client,
        live,
        "signPsbt",
        {
          account: BIP84_FIRST,
          psbt: base64.encode(psbt),
          signInputs: [{ address: BIP84_FIRST, index: 0 }],
        },
        BTC_MAIN,
      );
      await sign.approve("bitcoin-sign");
      const result = value(await sign.settled) as { psbt: string };
      const signedPsbt = base64.decode(result.psbt);
      const account = await chains(r.wallet).account({
        walletId: r.walletId,
        groupIndex: 0,
        template: "btc.bip84",
        network: BTC_MAIN,
      });
      const xpub = "xpub" in account ? (account.xpub ?? "") : "";
      expect(verifyBitcoinPsbtSignatures(signedPsbt, [0], xpub, "btc.bip84", BTC_MAIN)).toBe(true);

      const send = await call(
        r,
        client,
        live,
        "signPsbt",
        {
          account: BIP84_FIRST,
          psbt: base64.encode(dappPsbt({ from: BIP84_FIRST, to: RECIP, value: 50_000n })),
          signInputs: [{ address: BIP84_FIRST, index: 0 }],
          broadcast: true,
        },
        BTC_MAIN,
      );
      await send.approve("bitcoin-sign");
      const sent = value(await send.settled) as { psbt: string; txid: string };
      expect(sent.txid).toHaveLength(64);
      expect(
        broadcasts.some((body) => Transaction.fromRaw(hex.decode(body)).id === sent.txid),
      ).toBe(true);
      expect(acceptedTxids.has(sent.txid)).toBe(true);
      await r.wc.dispose();
    },
  );

  it(
    "refuses bad sighashTypes, a foreign account and malformed intentions",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client, bip122Namespaces());
      const psbt = dappPsbt({ from: BIP84_FIRST, to: RECIP, value: 100_000n });
      const fail = async (params: unknown, code: number): Promise<void> => {
        const settled = client
          .request({
            topic: live.topic,
            chainId: BTC_MAIN,
            request: { method: "signPsbt", params },
          })
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({ error: error as { code?: number } }));
        await expect(settled).resolves.toMatchObject({ error: { code } });
      };
      await fail(
        {
          account: BIP84_FIRST,
          psbt: base64.encode(psbt),
          signInputs: [{ address: BIP84_FIRST, index: 0, sighashTypes: [2] }],
        },
        -32_602,
      );
      await fail(
        {
          account: BIP84_FIRST,
          psbt: base64.encode(psbt),
          signInputs: [{ address: BIP84_FIRST, index: 0, sighashTypes: [1, 3] }],
        },
        -32_602,
      );
      await fail({ account: "bc1qother", psbt: base64.encode(psbt), signInputs: [] }, 4100);
      await r.wc.dispose();
    },
  );

  it(
    "sends a transfer through the send pipeline with the walletconnect origin",
    { timeout: 180_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client, bip122Namespaces());
      fundPrev(BIP84_FIRST, 100_000n);
      const send = await call(
        r,
        client,
        live,
        "sendTransfer",
        { account: BIP84_FIRST, recipientAddress: RECIP, amount: "25000" },
        BTC_MAIN,
      );
      const request = Object.values(r.engine.requests.getState().requests).find(
        (entry) => entry.id === send.requestId(),
      );
      expect(request).toMatchObject({
        method: "send",
        origin: { kind: "walletconnect" },
      });
      await send.approve("send");
      const result = value(await send.settled) as { txid: string };
      expect(
        broadcasts.some((body) => Transaction.fromRaw(hex.decode(body)).id === result.txid),
      ).toBe(true);
      await r.wc.dispose();
    },
  );

  it(
    "refuses a memo with 4200 and malformed amounts with -32602",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client, bip122Namespaces());
      const fail = async (params: unknown, code: number): Promise<void> => {
        const settled = client
          .request({
            topic: live.topic,
            chainId: BTC_MAIN,
            request: { method: "sendTransfer", params },
          })
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({ error: error as { code?: number } }));
        await expect(settled).resolves.toMatchObject({ error: { code } });
      };
      await fail(
        { account: BIP84_FIRST, recipientAddress: RECIP, amount: "1000", memo: "op_return" },
        4200,
      );
      await fail({ account: BIP84_FIRST, recipientAddress: RECIP, amount: "0" }, -32_602);
      await fail({ account: BIP84_FIRST, recipientAddress: RECIP, amount: "abc" }, -32_602);
      await fail(
        { account: BIP84_FIRST, recipientAddress: RECIP, amount: "2100000000000000001" },
        -32_602,
      );
      expect(awaiting(r)).toHaveLength(0);
      await r.wc.dispose();
    },
  );
});
