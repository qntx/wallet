/**
 * Shared fake-Esplora + TransactionController rig for the engine-data audit PoCs. Modelled on
 * tests/bitcoin-rbf.test.ts but wired to a real TransactionController (the tests there drive the
 * route directly and therefore cannot reach controller-level behaviour such as the `replaced`
 * sibling transition or restart-time decode).
 */
import { HDKey } from "@scure/bip32";
import { NETWORK, p2wpkh, Transaction } from "@scure/btc-signer";

import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import type { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import type { SignParams, TrackedTransaction, TxState } from "../../src/transactions/route.ts";

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

export const HD = HDKey.fromMasterSeed(new Uint8Array(64).fill(1)).derive("m/84'/0'/0'");
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

const { script } = p2wpkh(pubkey(PUB), NETWORK);
const OUR_HASH = scripthash(OUR_ADDR, NETWORK);
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
  readonly timers: Array<() => unknown>;
  readonly backing: Backing;
};

export type BtcWorld = {
  readonly boot: (backing?: Backing) => Promise<Booted>;
  readonly send: (booted: Booted, amount: bigint, requestId: string) => Promise<TrackedTransaction>;
  readonly fund: (seed: number, value: number, confirmed?: boolean) => FakeUtxo;
  readonly spend: (txid: string, vout: number) => void;
  readonly markUsed: (hash: string, txid: string) => void;
  readonly setStatus: (txid: string, s: unknown) => void;
  readonly utxos: Map<string, FakeUtxo[]>;
  readonly statuses: Map<string, unknown>;
  readonly broadcasts: string[];
  readonly signedCalls: SignParams[];
  readonly clock: { t: number };
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

/** `tx.hash` with the undefined case collapsed — the audited flows always set it. */
export const hashOf = (tx: TrackedTransaction): string => tx.hash ?? "";

/** The tracked tx's recorded btc input txids. */
export const inputTxidsOf = (tx: TrackedTransaction): ReadonlyArray<string> =>
  (tx.btc?.inputs ?? []).map((i) => i.txid);

/** One poll tick for the timer captured at `index`. */
export const tick = async (timers: ReadonlyArray<() => unknown>, index: number): Promise<void> => {
  await timers[index]?.();
};

/**
 * `count` sequential poll ticks — recursion, like evm-drop.test.ts's `ticks`, to avoid
 * await-in-loop.
 */
export const ticks = async (
  timers: ReadonlyArray<() => unknown>,
  count: number,
  index = 0,
): Promise<void> => {
  if (count <= 0) {
    return;
  }
  await tick(timers, index);
  await ticks(timers, count - 1, index);
};

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
  return prepared.submit(VERIFY);
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

export const world = (): BtcWorld => {
  /** Txid → raw transaction bytes (funding txs and everything the wallet broadcasts). */
  const raws = new Map<string, Uint8Array>();
  /** Scripthash → currently-unspent outputs (the test moves coins by hand). */
  const utxos = new Map<string, FakeUtxo[]>();
  /** Scripthash → every txid it ever touched, so /txs marks the address `used`. */
  const history = new Map<string, Set<string>>();
  /** Txid → the /status payload; "404" makes the esplora get throw like electrs does. */
  const statuses = new Map<string, unknown>();
  const broadcasts: string[] = [];
  const signedCalls: SignParams[] = [];

  const markUsed = (hash: string, txid: string): void => {
    const set = history.get(hash) ?? new Set<string>();
    set.add(txid);
    history.set(hash, set);
  };

  /** A real transaction paying receive-address 0 — its txid survives the prevout checks. */
  const fund = (seed: number, value: number, confirmed = true): FakeUtxo => {
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: SEED_TXID(seed), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script, amount: BigInt(value) });
    raws.set(prev.id, prev.toBytes(true, false));
    const utxo: FakeUtxo = { txid: prev.id, vout: 0, value, confirmed };
    const list = utxos.get(OUR_HASH) ?? [];
    list.push(utxo);
    utxos.set(OUR_HASH, list);
    markUsed(OUR_HASH, prev.id);
    return utxo;
  };

  /** Removes an outpoint from the unspent set — what confirmation of its spender does. */
  const spend = (txid: string, vout: number): void => {
    utxos.set(
      OUR_HASH,
      (utxos.get(OUR_HASH) ?? []).filter((u) => !(u.txid === txid && u.vout === vout)),
    );
  };

  const get = (url: string): unknown => {
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
    const sm = /^\/tx\/([0-9a-f]{64})\/status$/.exec(url);
    if (sm !== null) {
      const s = statuses.get(sm[1] ?? "");
      // A real Esplora answers 404 for an unknown/evicted txid — the client throws.
      if (s === undefined || s === "404") {
        throw new Error(`esplora ${sm[1] ?? ""}/status: 404`);
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
      const raw = new Uint8Array(Buffer.from(body, "hex"));
      const tx = Transaction.fromRaw(raw, { allowUnknownInputs: true });
      raws.set(tx.id, raw);
      broadcasts.push(tx.id);
      return tx.id;
    },
  };

  const apis = stub(
    {
      account: async (p: { groupIndex: number }) => {
        await Promise.resolve();
        return {
          template: "btc.bip84",
          network: NET,
          groupIndex: p.groupIndex,
          xpub: HD.publicExtendedKey,
          fingerprint: "00000000",
          path: "m/84'/0'/0'",
        };
      },
      sign: async (p: SignParams) => {
        await Promise.resolve();
        signedCalls.push(p);
        const req = p.request;
        if (req.kind !== "bitcoin.psbt") {
          throw new Error("wrong kind");
        }
        const tx = Transaction.fromPSBT(req.psbt);
        for (let i = 0; i < tx.inputsLength; i += 1) {
          const path = inputPath(tx.getInput(i));
          const key = HD.deriveChild(path.at(-2) ?? 0).deriveChild(path.at(-1) ?? 0);
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
    const timers: Array<() => unknown> = [];
    const store = backing ?? { collections: new Map<string, Map<string, Uint8Array>>() };
    const ctl = new TransactionController({
      wallet: stub({}, isWallet),
      networks: stub(
        {
          info: () => ({ family: "bitcoin" }),
          esplora: () => esploraStub,
          independentEsplora: () => ({ kind: "not-needed" }),
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
      setTimer: (ms, fn) => {
        // Only the poll timer (pollMs = 1) is captured; other one-shot timers are ignored.
        if (ms === 1) {
          timers.push(fn);
        }
        return () => undefined;
      },
      now: () => clock.t,
      logger: { warn: () => undefined },
      pollMs: 1,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers, backing: store };
  };

  return {
    boot,
    send,
    fund,
    spend,
    markUsed,
    setStatus: (txid: string, s: unknown) => {
      statuses.set(txid, s);
    },
    statuses,
    utxos,
    broadcasts,
    signedCalls,
    clock,
    persistedUtxos,
    persistedTx,
    OUR_HASH,
  };
};
