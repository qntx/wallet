/**
 * Shared fake-Esplora + TransactionController rig for bitcoin tests. Modelled on
 * tests/bitcoin-rbf.test.ts but wired to a real TransactionController (the tests there drive the
 * route directly and therefore cannot reach controller-level behaviour such as the `replaced`
 * sibling transition or restart-time decode). Polling runs on `manualTimers` — faithful one-shot
 * `setTimeout` semantics — so a loop that forgets to re-arm stops, exactly as in production.
 */
import { HDKey } from "@scure/bip32";
import { NETWORK, p2wpkh, Transaction } from "@scure/btc-signer";

import type { Wallet } from "@qntx/wallet";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import { bitcoinAddressFromXpub } from "@qntx/wallet-chains/bitcoin";
import type { chains } from "@qntx/wallet/chains";

import { scripthash, scriptPubKey } from "../../src/chains/bitcoin-scan.ts";
import { EsploraError } from "../../src/chains/bitcoin.ts";
import type { Esplora } from "../../src/chains/bitcoin.ts";
import type { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import type { SignParams, TrackedTransaction, TxState } from "../../src/transactions/route.ts";
import { manualTimers } from "./timers.ts";
import type { ManualTimers } from "./timers.ts";

/** The rig's poll interval; `Booted.polls` fires it once per poll. */
export const POLL_MS = 4000;

/** Type-narrowing stubs, like tests/send-helpers.ts's `noSpark` — no `as` casts needed. */
const isWallet = (_v: unknown): _v is Wallet => true;
const isNetworks = (_v: unknown): _v is NetworkController => true;
const isChainsApis = (_v: unknown): _v is ReturnType<typeof chains> => true;

const stub = <T>(v: unknown, guard: (v: unknown) => v is T): T => {
  if (guard(v)) {
    return v;
  }
  throw new Error("unreachable");
};

const pubkey = (key: HDKey): Uint8Array => {
  const p = key.publicKey;
  if (p === undefined || p === null) {
    throw new Error("hd key has no public key");
  }
  return p;
};

const privkey = (key: HDKey): Uint8Array => {
  const p = key.privateKey;
  if (p === undefined || p === null) {
    throw new Error("hd key has no private key");
  }
  return p;
};

/** Reads a PSBT input's bip32/taproot derivation path without trusting scure's `any` types. */
const numberArray = (v: unknown): ReadonlyArray<number> | undefined =>
  Array.isArray(v) && v.every((n) => typeof n === "number") ? v : undefined;

const pairMeta = (v: unknown): unknown => {
  if (!Array.isArray(v) || !Array.isArray(v[0]) || v[0].length < 2) {
    return undefined;
  }
  const meta: unknown = v[0][1];
  return meta;
};

const bip32Path = (input: { bip32Derivation?: unknown }): ReadonlyArray<number> | undefined => {
  const meta = pairMeta(input.bip32Derivation);
  if (typeof meta !== "object" || meta === null || !("path" in meta)) {
    return undefined;
  }
  return numberArray(meta.path);
};

const tapPath = (input: { tapBip32Derivation?: unknown }): ReadonlyArray<number> | undefined => {
  const meta = pairMeta(input.tapBip32Derivation);
  if (typeof meta !== "object" || meta === null || !("der" in meta)) {
    return undefined;
  }
  const { der } = meta;
  if (typeof der !== "object" || der === null || !("path" in der)) {
    return undefined;
  }
  return numberArray(der.path);
};

const inputPath = (input: {
  bip32Derivation?: unknown;
  tapBip32Derivation?: unknown;
}): ReadonlyArray<number> => bip32Path(input) ?? tapPath(input) ?? [0, 0];

const SEED = new Uint8Array(64).fill(1);
const PURPOSE: Record<string, number> = {
  "btc.bip44": 44,
  "btc.bip49": 49,
  "btc.bip84": 84,
  "btc.bip86": 86,
};
/** The account root for a template — each legacy template gets its honest purpose path. */
const rootOf = (template: string): HDKey =>
  HDKey.fromMasterSeed(SEED).derive(`m/${PURPOSE[template] ?? 84}'/0'/0'`);

export const HD = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'");
export const PUB = HD.deriveChild(0).deriveChild(0);
export const OUR_ADDR = p2wpkh(pubkey(PUB), NETWORK).address;
export const CHANGE_ADDR = p2wpkh(pubkey(HD.deriveChild(1).deriveChild(0)), NETWORK).address;
export const RECIP = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
export const NET = "bip122:000000000019d6689c085ae165831e93";
export const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "btc.bip84" as const,
};
export const VERIFY = { kind: "password" as const, password: "pw" };

const SEED_TXID = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);

export type FakeUtxo = {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly confirmed: boolean;
};

export type Backing = { collections: Map<string, Map<string, Uint8Array>> };
export type Booted = {
  readonly ctl: TransactionController;
  readonly timers: ManualTimers;
  readonly backing: Backing;
  /** `n` sequential status polls — one `fire(POLL_MS)` each, the loop re-arming between them. */
  readonly polls: (n?: number) => Promise<void>;
};

export type PostMode =
  | { readonly kind: "ok" }
  /** The node keeps the transaction but the answer is lost (5xx, timeout). */
  | { readonly kind: "accept-then-throw"; readonly error: unknown }
  /** The answer says nothing reliable — a transport failure or a node refusal. */
  | { readonly kind: "throw"; readonly error: unknown };

export type BtcWorld = {
  readonly boot: (backing?: Backing) => Promise<Booted>;
  readonly send: (booted: Booted, amount: bigint, requestId: string) => Promise<TrackedTransaction>;
  readonly fund: (seed: number, value: number, confirmed?: boolean) => FakeUtxo;
  readonly spend: (txid: string, vout: number) => void;
  readonly markUsed: (hash: string, txid: string) => void;
  readonly setStatus: (txid: string, s: unknown) => void;
  readonly setIndependentStatus: (txid: string, s: unknown) => void;
  /** Scripts the `/tx/:prevTxid/outspends` answer — any value, or an Error to make the read fail. */
  readonly setOutspends: (txid: string, answer: unknown) => void;
  /** Marks `prevTxid:vout` spent by `spenderTxid` in the outspends index. */
  readonly spendBy: (
    prevTxid: string,
    vout: number,
    spenderTxid: string,
    confirmed: boolean,
  ) => void;
  readonly setPost: (mode: PostMode) => void;
  readonly utxos: Map<string, FakeUtxo[]>;
  readonly statuses: Map<string, unknown>;
  readonly broadcasts: string[];
  /** Every POST /tx body the endpoint was asked about, in order — accepted or not. */
  readonly posts: string[];
  /** Every esplora `get` path, in order — filter to count a particular endpoint's calls. */
  readonly requests: string[];
  readonly signedCalls: SignParams[];
  /** Every message the engine's logger warned about, in order. */
  readonly warnings: string[];
  readonly clock: { t: number };
  /** The same chains api and endpoint the controller was wired with — for the dApp paths. */
  readonly apis: ReturnType<typeof chains>;
  readonly es: Esplora;
  readonly persistedUtxos: (
    backing: Backing,
  ) => Promise<Record<string, { status?: string; txId?: string }>>;
  readonly persistedTx: (
    backing: Backing,
    id: string,
  ) => Promise<Record<string, unknown> | undefined>;
  readonly OUR_HASH: string;
};

export const stateOf = (ctl: TransactionController, tx: TrackedTransaction): TxState | undefined =>
  ctl.getState().txs[tx.id]?.state;

/** `tx.hash` with the undefined case collapsed — the tracked flows always set it. */
export const hashOf = (tx: TrackedTransaction): string => tx.hash ?? "";

/** The tracked tx's recorded btc input txids. */
export const inputTxidsOf = (tx: TrackedTransaction): ReadonlyArray<string> =>
  (tx.btc?.inputs ?? []).map((i) => i.txid);

/** Fire-and-forget store writes (BtcUtxoStore.persist is `void`ed) need one macrotask. */
export const flush = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve);
  });
};

const readJson = (raw: Uint8Array | undefined): unknown => {
  if (raw === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
  return parsed;
};

const isStringRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asUtxoMap = (v: unknown): Record<string, { status?: string; txId?: string }> => {
  const out: Record<string, { status?: string; txId?: string }> = {};
  if (!isStringRecord(v)) {
    return out;
  }
  for (const [k, entry] of Object.entries(v)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const e: { status?: string; txId?: string } = {};
    if ("status" in entry && typeof entry.status === "string") {
      e.status = entry.status;
    }
    if ("txId" in entry && typeof entry.txId === "string") {
      e.txId = entry.txId;
    }
    out[k] = e;
  }
  return out;
};

const asRecord = (v: unknown): Record<string, unknown> | undefined => {
  if (!isStringRecord(v)) {
    return undefined;
  }
  return { ...v };
};

export const send = async (
  booted: Booted,
  amount: bigint,
  requestId: string,
): Promise<TrackedTransaction> => {
  const prepared = await booted.ctl.prepareSend(
    { account: ACCOUNT, network: NET, to: RECIP, amount, fee: "slow" },
    requestId,
  );
  return prepared.submit(VERIFY, () => undefined);
};

export const persistedUtxos = async (
  backing: Backing,
): Promise<Record<string, { status?: string; txId?: string }>> => {
  const raw = await createMemoryEngineStore(backing).collection("btc-utxos").get("state");
  return asUtxoMap(readJson(raw));
};

export const persistedTx = async (
  backing: Backing,
  id: string,
): Promise<Record<string, unknown> | undefined> => {
  const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
  return asRecord(readJson(raw));
};

export const world = (
  options: { readonly independent?: boolean; readonly template?: BitcoinAccountTemplate } = {},
): BtcWorld => {
  /** The world's own account template — bip84 unless the test asks for a legacy one. */
  const template: BitcoinAccountTemplate = options.template ?? "btc.bip84";
  const ownAddr = bitcoinAddressFromXpub(rootOf(template).publicExtendedKey, template, NET, 0, 0);
  const ownScript = scriptPubKey(ownAddr, NETWORK);
  const ownHash = scripthash(ownAddr, NETWORK);
  /** Txid → raw transaction bytes (funding txs and everything the wallet broadcasts). */
  const raws = new Map<string, Uint8Array>();
  /** Scripthash → currently-unspent outputs (the test moves coins by hand). */
  const utxos = new Map<string, FakeUtxo[]>();
  /** Scripthash → every txid it ever touched, so /txs marks the address `used`. */
  const history = new Map<string, Set<string>>();
  /** Txid → the /status payload; "404" makes the esplora get throw like electrs does. */
  const statuses = new Map<string, unknown>();
  /** A second endpoint's statuses, when `options.independent` asks for one. */
  const independentStatuses = new Map<string, unknown>();
  /** Txid → scripted `/outspends` answer; unset falls back to "no output spent". */
  const outspends = new Map<string, unknown>();
  const broadcasts: string[] = [];
  const posts: string[] = [];
  const requests: string[] = [];
  const signedCalls: SignParams[] = [];
  const warnings: string[] = [];
  let postMode: PostMode = { kind: "ok" };

  const markUsed = (hash: string, txid: string): void => {
    const set = history.get(hash) ?? new Set<string>();
    set.add(txid);
    history.set(hash, set);
  };

  /** A real transaction paying receive-address 0 — its txid survives the prevout checks. */
  const fund = (seed: number, value: number, confirmed = true): FakeUtxo => {
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: SEED_TXID(seed), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: ownScript, amount: BigInt(value) });
    raws.set(prev.id, prev.toBytes(true, false));
    const utxo: FakeUtxo = { txid: prev.id, vout: 0, value, confirmed };
    const list = utxos.get(ownHash) ?? [];
    list.push(utxo);
    utxos.set(ownHash, list);
    markUsed(ownHash, prev.id);
    return utxo;
  };

  /** Removes an outpoint from the unspent set — what confirmation of its spender does. */
  const spend = (txid: string, vout: number): void => {
    utxos.set(
      ownHash,
      (utxos.get(ownHash) ?? []).filter((u) => !(u.txid === txid && u.vout === vout)),
    );
  };

  const get = (url: string): unknown => {
    requests.push(url);
    const sh = /^\/scripthash\/([0-9a-f]{64})\/(txs|utxo)$/.exec(url);
    if (sh !== null) {
      const h = sh[1] ?? "";
      if (sh[2] === "txs") {
        return [...(history.get(h) ?? [])].map((txid) => ({ txid }));
      }
      return (utxos.get(h) ?? []).map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        status: u.confirmed ? { confirmed: true, block_height: 100 } : { confirmed: false },
      }));
    }
    if (url === "/fee-estimates") {
      return { "1": 20, "3": 10, "6": 5, "144": 1 };
    }
    const hm = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(url);
    if (hm !== null) {
      return Buffer.from(raws.get(hm[1] ?? "") ?? new Uint8Array()).toString("hex");
    }
    const om = /^\/tx\/([0-9a-f]{64})\/outspends$/.exec(url);
    if (om !== null) {
      const answer = outspends.get(om[1] ?? "");
      if (answer instanceof Error) {
        throw answer;
      }
      if (answer !== undefined) {
        return answer;
      }
      const raw = raws.get(om[1] ?? "");
      if (raw === undefined) {
        throw new EsploraError(`esplora ${url}: 404`, false);
      }
      const tx = Transaction.fromRaw(raw, { allowUnknownInputs: true });
      return Array.from({ length: tx.outputsLength }, () => ({ spent: false }));
    }
    const sm = /^\/tx\/([0-9a-f]{64})\/status$/.exec(url);
    if (sm !== null) {
      const s = statuses.get(sm[1] ?? "");
      // A scripted Error answers the read with that failure — a 503, a timeout, a 4xx.
      if (s instanceof Error) {
        throw s;
      }
      // A real Esplora answers 404 for an unknown/evicted txid — the client throws.
      if (s === undefined || s === "404") {
        throw new EsploraError(`esplora ${url}: 404`, false);
      }
      return s;
    }
    throw new Error(`unmocked esplora get ${url}`);
  };

  const esploraStub = {
    get: async (u: string) => {
      await Promise.resolve();
      return get(u);
    },
    post: async (_u: string, body: string) => {
      await Promise.resolve();
      posts.push(body);
      if (postMode.kind === "throw") {
        throw postMode.error;
      }
      const raw = new Uint8Array(Buffer.from(body, "hex"));
      const tx = Transaction.fromRaw(raw, { allowUnknownInputs: true });
      raws.set(tx.id, raw);
      broadcasts.push(tx.id);
      if (postMode.kind === "accept-then-throw") {
        throw postMode.error;
      }
      return tx.id;
    },
  };

  /** The independent endpoint: only /status is asked of it (esploraKnows). */
  const independentStub = {
    get: async (u: string) => {
      await Promise.resolve();
      const sm = /^\/tx\/([0-9a-f]{64})\/status$/.exec(u);
      if (sm !== null) {
        const s = independentStatuses.get(sm[1] ?? "");
        if (s instanceof Error) {
          throw s;
        }
        if (s === undefined) {
          throw new EsploraError(`esplora ${u}: 404`, false);
        }
        return s;
      }
      throw new Error(`unmocked independent esplora get ${u}`);
    },
    post: async () => {
      await Promise.resolve();
      throw new Error("unmocked independent esplora post");
    },
  };

  const apis = stub(
    {
      account: async (p: { groupIndex: number; template?: BitcoinAccountTemplate }) => {
        await Promise.resolve();
        const t = p.template ?? "btc.bip84";
        const root = rootOf(t);
        return {
          template: t,
          network: NET,
          groupIndex: p.groupIndex,
          xpub: root.publicExtendedKey,
          fingerprint: "00000000",
          path: `m/${PURPOSE[t] ?? 84}'/0'/0'`,
        };
      },
      sign: async (p: SignParams) => {
        await Promise.resolve();
        signedCalls.push(p);
        const req = p.request;
        if (req.kind !== "bitcoin.psbt") {
          throw new Error("wrong kind");
        }
        const root = rootOf(req.sign[0]?.template ?? template);
        const tx = Transaction.fromPSBT(req.psbt);
        for (let i = 0; i < tx.inputsLength; i += 1) {
          const path = inputPath(tx.getInput(i));
          const key = root.deriveChild(path.at(-2) ?? 0).deriveChild(path.at(-1) ?? 0);
          tx.signIdx(privkey(key), i);
        }
        return { kind: "bitcoin.psbt", signedPsbt: tx.toPSBT() };
      },
    },
    isChainsApis,
  );

  const clock = { t: 1_000_000 };
  let tag = 0;

  const boot = async (backing?: Backing): Promise<Booted> => {
    const timers = manualTimers();
    const store = backing ?? { collections: new Map<string, Map<string, Uint8Array>>() };
    const ctl = new TransactionController({
      wallet: stub({}, isWallet),
      networks: stub(
        {
          info: () => ({ family: "bitcoin" }),
          esplora: () => esploraStub,
          independentEsplora: () =>
            options.independent === true
              ? { kind: "available", client: independentStub }
              : { kind: "not-needed" },
        },
        isNetworks,
      ),
      openStore: async () => {
        await Promise.resolve();
        return createMemoryEngineStore(store);
      },
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag % 256);
      },
      setTimer: timers.setTimer,
      now: () => clock.t,
      logger: {
        warn: (msg) => {
          warnings.push(msg);
        },
      },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    const polls = async (n = 1): Promise<void> => {
      for (let i = 0; i < n; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each poll re-arms the next
        await timers.fire(POLL_MS);
      }
    };
    return { ctl, timers, backing: store, polls };
  };

  return {
    boot,
    send: async (booted, amount, requestId) => {
      const prepared = await booted.ctl.prepareSend(
        { account: { ...ACCOUNT, template }, network: NET, to: RECIP, amount, fee: "slow" },
        requestId,
      );
      return prepared.submit(VERIFY, () => undefined);
    },
    fund,
    spend,
    markUsed,
    setStatus: (txid: string, s: unknown) => {
      statuses.set(txid, s);
    },
    setIndependentStatus: (txid: string, s: unknown) => {
      independentStatuses.set(txid, s);
    },
    setOutspends: (txid: string, answer: unknown) => {
      outspends.set(txid, answer);
    },
    spendBy: (prevTxid: string, vout: number, spenderTxid: string, confirmed: boolean) => {
      const cur = outspends.get(prevTxid);
      const list: unknown[] = Array.isArray(cur) ? [...(cur as ReadonlyArray<unknown>)] : [];
      while (list.length <= vout) {
        list.push({ spent: false });
      }
      list[vout] = {
        spent: true,
        txid: spenderTxid,
        vin: 0,
        status: { confirmed, ...(confirmed ? { block_height: 100 } : {}) },
      };
      outspends.set(prevTxid, list);
    },
    setPost: (mode: PostMode) => {
      postMode = mode;
    },
    statuses,
    utxos,
    broadcasts,
    posts,
    requests,
    signedCalls,
    warnings,
    clock,
    apis,
    es: esploraStub,
    persistedUtxos,
    persistedTx,
    OUR_HASH: ownHash,
  };
};
