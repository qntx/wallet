import { hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { NETWORK, p2wpkh, Transaction } from "@scure/btc-signer";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { scripthash } from "../src/chains/bitcoin-scan.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { createBitcoinRoute } from "../src/transactions/bitcoin.ts";
import type {
  RouteContext,
  SignParams,
  TrackedTransaction,
  TxState,
} from "../src/transactions/route.ts";
import { routeCpfp, routeReplace, routeSend } from "./send-helpers.ts";

const HD = HDKey.fromMasterSeed(new Uint8Array(64).fill(1)).derive("m/84'/0'/0'");
const PUB = HD.deriveChild(0).deriveChild(0);
const TO_ADDR = p2wpkh(PUB.publicKey!, NETWORK).address;
/** The first change index the wallet picks: mark 0 hands out /1/1 — index 0 is never used. */
const CHANGE_ADDR = p2wpkh(HD.deriveChild(1).deriveChild(1).publicKey!, NETWORK).address;
const CHANGE_ADDR_2 = p2wpkh(HD.deriveChild(1).deriveChild(2).publicKey!, NETWORK).address;
const TXID = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const { script } = p2wpkh(PUB.publicKey!, NETWORK);

const OUR_HASH = scripthash(TO_ADDR, NETWORK);
/** A real funding tx paying `script` — its txid survives the engine's prevout checks. */
const PREVS = new Map<string, Uint8Array>();
const funding = (seed: number, value: number): { txid: string; raw: Uint8Array } => {
  const prev = new Transaction({ version: 2 });
  prev.addInput({ txid: TXID(seed), index: 0, sequence: 0xffffffff });
  prev.addOutput({ script, amount: BigInt(value) });
  const raw = prev.toBytes(true, false);
  PREVS.set(prev.id, raw);
  return { txid: prev.id, raw };
};
const DEFAULT_UTXOS = [
  { txid: funding(1, 50_000).txid, vout: 0, value: 50_000 },
  { txid: funding(2, 30_000).txid, vout: 0, value: 30_000 },
];
let utxoList = [...DEFAULT_UTXOS];
const setUtxos = (list: ReadonlyArray<{ txid: string; vout: number; value: number }>): void => {
  utxoList = [...list];
};
const hexCalls: string[] = [];
const get = (url: string): unknown => {
  const sh = /^\/scripthash\/([0-9a-f]{64})\/(txs|utxo)$/.exec(url);
  if (sh !== null) {
    if (sh[1] !== OUR_HASH) {
      return [];
    }
    return sh[2] === "txs"
      ? utxoList.map((u) => ({ txid: u.txid }))
      : utxoList.map((u) => ({ ...u, status: { confirmed: true, block_height: 1 } }));
  }
  if (url === "/fee-estimates") {
    return { "1": 20, "3": 10, "6": 5, "144": 1 };
  }
  const hm = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(url);
  if (hm !== null) {
    hexCalls.push(hm[1] ?? "");
    return Buffer.from(PREVS.get(hm[1] ?? "") ?? new Uint8Array()).toString("hex");
  }
  const m = /^\/tx\/([0-9a-f]{64})$/.exec(url);
  if (m !== null) {
    const u = utxoList.find((x) => x.txid === m[1]);
    return {
      vin: [{}],
      vout: [
        {
          scriptpubkey: Buffer.from(script).toString("hex"),
          scriptpubkey_address: TO_ADDR,
          value: u?.value ?? 0,
        },
      ],
      status: { confirmed: true, block_height: 1 },
    };
  }
  return { confirmed: false };
};
const posted: string[] = [];
const esploraStub = {
  get: async (u: string) => Promise.resolve(get(u)),
  post: async (_u: string, body: string) => {
    posted.push(body);
    const raw = new Uint8Array(Buffer.from(body, "hex"));
    const { id } = Transaction.fromRaw(raw, { allowUnknownInputs: true });
    PREVS.set(id, raw);
    return Promise.resolve(id);
  },
};

const signedCalls: SignParams[] = [];
/** What the account mock reports as `confirmed` — a device entry never confirmed reports false. */
let accountConfirmed = true;
let route = createBitcoinRoute();
let independentMode:
  | { kind: "not-needed" }
  | { kind: "unavailable" }
  | { kind: "available"; source: "host"; client: typeof esploraStub } = { kind: "not-needed" };
let id = 0;
const nextId = (): string => {
  id += 1;
  return `tx-${id}`;
};
const btcOf = (tx: TrackedTransaction): NonNullable<TrackedTransaction["btc"]> => {
  if (tx.btc === undefined) {
    throw new Error("no btc record");
  }
  return tx.btc;
};
const valueOf = (o: { readonly value: number } | undefined): number => {
  if (o === undefined) {
    throw new Error("missing output");
  }
  return o.value;
};
const ctx = (transitions: TrackedTransaction[] = []): RouteContext => ({
  options: {
    networks: {
      esplora: () => esploraStub,
      independentEsplora: () => independentMode,
    } as never,
    wallet: {} as never,
    openStore: async () => Promise.resolve({} as never),
    random: (n: number) => new Uint8Array(n).fill(0xaa),
    setTimer: () => () => {},
    now: () => 0,
    logger: { warn: () => {} },
    chains: {
      account: async (p: { groupIndex: number }) =>
        Promise.resolve({
          template: "btc.bip84",
          network: "bip122:000000000019d6689c085ae165831e93",
          groupIndex: p.groupIndex,
          xpub: HD.publicExtendedKey,
          fingerprint: "00000000",
          path: "m/84'/0'/0'",
          changeMark: 0,
          confirmed: accountConfirmed,
        }),
      sign: async (p: SignParams) => {
        signedCalls.push(p);
        const req = p.request;
        if (req.kind !== "bitcoin.psbt") {
          return Promise.reject(new Error("wrong kind"));
        }
        const tx = Transaction.fromPSBT(req.psbt);
        for (let i = 0; i < tx.inputsLength; i += 1) {
          const input = tx.getInput(i);
          const deriv =
            input.bip32Derivation?.[0]?.[1].path ?? input.tapBip32Derivation?.[0]?.[1].der.path;
          const path = deriv ?? [0, 0];
          const key = HD.deriveChild(path.at(-2) ?? 0).deriveChild(path.at(-1) ?? 0);
          tx.signIdx(key.privateKey!, i);
        }
        return { kind: "bitcoin.psbt", signedPsbt: tx.toPSBT() };
      },
    } as never,
  },
  transition: async (tx, next) => {
    const out = { ...tx, ...next };
    transitions.push(out);
    return Promise.resolve(out);
  },
  track: () => {},
  txs: () => ({}),
  newId: nextId,
});

const signedPsbt = (n: number): Transaction => {
  const req = signedCalls[n]?.request;
  if (req === undefined || req.kind !== "bitcoin.psbt") {
    throw new Error("expected a bitcoin.psbt sign call");
  }
  return Transaction.fromPSBT(req.psbt);
};

const inputTxids = (tx: Transaction): ReadonlyArray<string> =>
  Array.from({ length: tx.inputsLength }, (_, i) =>
    hex.encode(tx.getInput(i).txid ?? new Uint8Array()),
  );

const signGroupIndex = (n: number): number | undefined => {
  const req = signedCalls[n]?.request;
  return req !== undefined && req.account.kind === "hd" ? req.account.groupIndex : undefined;
};

/** A tracked send whose output sits at `address` — what `changeTaken` reads for `state`. */
const ownRow = (id: string, state: TxState, address: string, own = true): TrackedTransaction => ({
  id,
  family: "bitcoin",
  network: "bip122:000000000019d6689c085ae165831e93",
  account: "w",
  hash: TXID(0x99),
  state,
  intent: undefined,
  nonce: 0,
  btc: {
    inputs: [],
    outputs: [{ address, value: 1000, own }],
    vsize: 1,
    fee: 1,
    feeRate: 1,
    template: "btc.bip84",
    groupIndex: 0,
    tier: "slow",
  },
  submittedAt: 0,
  error: undefined,
});

/** The bound change index of a signed PSBT — the output derivation with `change === 1`. */
const boundChangeIndex = (tx: Transaction): number | undefined => {
  for (let i = 0; i < tx.outputsLength; i++) {
    for (const [, v] of tx.getOutput(i).bip32Derivation ?? []) {
      if (v.path[3] === 1) {
        return v.path[4];
      }
    }
  }
  return undefined;
};

const send = async (c: RouteContext, amount = 10_000n): Promise<TrackedTransaction> => {
  setUtxos(DEFAULT_UTXOS);
  return routeSend(route, c, {
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "btc.bip84" },
    network: "bip122:000000000019d6689c085ae165831e93",
    to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    amount,
    fee: "slow",
    verify: { kind: "password", password: "pw" },
  });
};

describe("bitcoin rbf", () => {
  beforeEach(() => {
    independentMode = { kind: "not-needed" };
    accountConfirmed = true;
    route = createBitcoinRoute();
  });

  it("a Spark deposit tag lands on the tracked transaction", async () => {
    setUtxos(DEFAULT_UTXOS);
    const tag = { walletId: "w", groupIndex: 0, network: "mainnet" as const };
    const prepared = await route.prepare(
      ctx(),
      {
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "btc.bip84" },
        network: "bip122:000000000019d6689c085ae165831e93",
        to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        amount: 10_000n,
        fee: "slow",
      },
      "req-deposit",
      tag,
    );
    const tx = await prepared.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(tx.sparkDeposit).toStrictEqual(tag);
    const plain = await send(ctx());
    expect(plain).not.toHaveProperty("sparkDeposit");
  });

  it("nextReceiveAddress is the first unused bip84 receive address", async () => {
    setUtxos(DEFAULT_UTXOS);
    const next = await route.nextReceiveAddress(
      ctx(),
      "w",
      0,
      "bip122:000000000019d6689c085ae165831e93",
    );
    expect(next).toStrictEqual({
      address: p2wpkh(HD.deriveChild(0).deriveChild(1).publicKey!, NETWORK).address,
      confirmed: true,
    });
  });

  it("cancel sends all inputs to the next change address", async () => {
    const c = ctx();
    const original = await send(c);
    const cancelled = await routeReplace(route, c, original, "cancel", {
      kind: "password",
      password: "pw",
    });
    const out = btcOf(cancelled).outputs;
    expect(out).toHaveLength(1);
    const [change] = out;
    expect(change?.address).toBe(CHANGE_ADDR);
    expect(change?.own).toBe(true);
    expect(cancelled.replaces).toBe(original.id);
    expect(btcOf(cancelled).fee).toBeGreaterThan(btcOf(original).fee);
  });

  it.each([
    // `draft` and `rejected` rows never signed — the kernel sealed the mark past their pick
    // before the first signature, so their own output stays free for the next send.
    ["draft", 1],
    ["rejected", 1],
    ["signed", 2],
    ["submitted", 2],
    ["pending", 2],
    ["confirmed", 2],
    ["failed", 2],
    ["dropped", 2],
    ["replaced", 2],
  ] as const)(
    "a `%s` row's own output counts only once its bytes exist — the next send takes /1/%d",
    async (state, index) => {
      const earlier = ownRow("earlier", state, CHANGE_ADDR);
      const c = { ...ctx(), txs: () => ({ earlier }) };
      const tx = await send(c);
      expect(tx.state).not.toBe("failed");
      expect(btcOf(tx).outputs.find((o) => o.own)?.address).toBe(
        p2wpkh(HD.deriveChild(1).deriveChild(index).publicKey!, NETWORK).address,
      );
    },
  );

  it("a confirmed row's payee output is taken too — an address the chain paid is never re-picked", async () => {
    /* `own: false` marks the payee side, but an outflow that landed on /1/1 paid that address on
       chain all the same — the next send must not hand it out as fresh change. */
    const earlier = ownRow("earlier", "confirmed", CHANGE_ADDR, false);
    const c = { ...ctx(), txs: () => ({ earlier }) };
    const tx = await send(c);
    expect(tx.state).not.toBe("failed");
    expect(btcOf(tx).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR_2);
  });

  it("a speed-up and a cancel of a change-paying parent reuse the parent's own output", async () => {
    /* /1/1 is burned by an older confirmed send, so the parent's change sits at /1/2 — and every
       replacement pays /1/2 back, never a fresh pick. The store the replacement reads holds the
       parent's row too, so a fresh pick would skip both taken addresses and hand out /1/3 —
       the reuse of /1/2 is the point, not an accident of an empty store. The PSBT binds the
       parent's own path, so the kernel classifies the output as change. */
    const earlier = ownRow("earlier", "confirmed", CHANGE_ADDR);
    const rows: Record<string, TrackedTransaction> = { earlier };
    const c = { ...ctx(), txs: () => rows };
    const parent = await send(c);
    rows[parent.id] = parent;
    expect(btcOf(parent).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR_2);

    const verify = { kind: "password" as const, password: "pw" };
    const bumped = await routeReplace(route, c, parent, "speed-up", verify);
    expect(btcOf(bumped).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR_2);
    expect(boundChangeIndex(signedPsbt(signedCalls.length - 1))).toBe(2);

    const cancelled = await routeReplace(route, c, parent, "cancel", verify);
    expect(btcOf(cancelled).outputs.map((o) => o.address)).toStrictEqual([CHANGE_ADDR_2]);
    expect(boundChangeIndex(signedPsbt(signedCalls.length - 1))).toBe(2);
  });

  it("speed-up bumps the fee (BIP-125 rule 4: fee + vsize) and keeps payee outputs", async () => {
    const c = ctx();
    const original = await send(c);
    const bumped = await routeReplace(route, c, original, "speed-up", {
      kind: "password",
      password: "pw",
    });
    expect(bumped.replaces).toBe(original.id);
    const payees = btcOf(bumped).outputs.filter((o) => !o.own);
    expect(payees.length).toBeGreaterThan(0);
    const before = btcOf(original);
    expect(btcOf(bumped).fee).toBeGreaterThanOrEqual(before.fee + before.vsize);
  });

  it("a speed-up and a CPFP from an unconfirmed entry acknowledge the danger on sign", async () => {
    /* The replacement's own change sits on a serving entry the device never confirmed — the
       intent decodes it as a plain send with the danger warning and the sign call carries the
       acknowledgement the kernel demands. */
    accountConfirmed = false;
    const c = ctx();
    const original = await send(c);
    const bumped = await routeReplace(route, c, original, "speed-up", {
      kind: "password",
      password: "pw",
    });
    expect(signedCalls.at(-1)?.acknowledgeUnconfirmed).toBe(true);
    expect(bumped.intent?.warnings.some((w) => w.kind === "unconfirmed-signer-output")).toBe(true);
    expect(bumped.intent?.outflows.every((o) => o.ownPath === undefined)).toBe(true);

    const child = await routeCpfp(route, c, original, 10, {
      kind: "password",
      password: "pw",
    });
    expect(signedCalls.at(-1)?.acknowledgeUnconfirmed).toBe(true);
    expect(child.intent?.warnings.some((w) => w.kind === "unconfirmed-signer-output")).toBe(true);
  });

  it("bumpChild builds a CPFP child spending our own outputs", async () => {
    const c = ctx();
    const parent = await send(c);
    const child = await routeCpfp(route, c, parent, 10, { kind: "password", password: "pw" });
    expect(child.parentId).toBe(parent.id);
    const childBtc = btcOf(child);
    const parentBtc = btcOf(parent);
    expect(childBtc.outputs[0]?.own).toBe(true);
    expect(childBtc.fee).toBeGreaterThanOrEqual(childBtc.vsize);
    const packageFee = childBtc.fee + parentBtc.fee;
    const packageVsize = childBtc.vsize + parentBtc.vsize;
    expect(packageFee).toBeGreaterThanOrEqual(Math.ceil(10 * packageVsize) - 1);
  });

  it("shrinks only the change output when the bump fits", async () => {
    const c = ctx();
    const original = await send(c);
    const bumped = await routeReplace(route, c, original, "speed-up", {
      kind: "password",
      password: "pw",
    });
    expect(btcOf(bumped).inputs).toHaveLength(btcOf(original).inputs.length);
    const oldChange = btcOf(original).outputs.find((o) => o.own);
    const newChange = btcOf(bumped).outputs.find((o) => o.own);
    expect(newChange).toBeDefined();
    expect(valueOf(newChange)).toBeLessThan(valueOf(oldChange));
  });

  it("adds confirmed inputs when the change cannot absorb the bump", async () => {
    setUtxos([
      { txid: funding(1, 50_000).txid, vout: 0, value: 50_000 },
      { txid: funding(2, 30_000).txid, vout: 0, value: 30_000 },
    ]);
    const c = ctx();
    const original = await send(c, 49_400n);
    const bumped = await routeReplace(route, c, original, "speed-up", {
      kind: "password",
      password: "pw",
    });
    expect(btcOf(bumped).inputs.length).toBeGreaterThan(btcOf(original).inputs.length);
  });

  it("fails before signing when the bump is unfundable", async () => {
    setUtxos([{ txid: funding(1, 21_000).txid, vout: 0, value: 21_000 }]);
    const c = ctx();
    const original = await routeSend(route, c, {
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "btc.bip84" },
      network: "bip122:000000000019d6689c085ae165831e93",
      to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      amount: 20_200n,
      fee: "slow",
      verify: { kind: "password", password: "pw" },
    });
    const before = signedCalls.length;
    await expect(
      routeReplace(route, c, original, "speed-up", { kind: "password", password: "pw" }),
    ).rejects.toThrow("insufficient");
    expect(signedCalls).toHaveLength(before);
  });

  describe("utxo reservation", () => {
    const params = {
      account: {
        kind: "hd" as const,
        walletId: "w",
        groupIndex: 0,
        template: "btc.bip84" as const,
      },
      network: "bip122:000000000019d6689c085ae165831e93",
      to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      amount: 10_000n,
      fee: "slow" as const,
    };
    const verify = { kind: "password" as const, password: "pw" };

    it("prepare locks the selected outputs under the request id; release frees them", async () => {
      setUtxos([{ txid: funding(1, 50_000).txid, vout: 0, value: 50_000 }]);
      const c = ctx();
      const first = await route.prepare(c, params, "req-1");
      await expect(route.prepare(c, params, "req-2")).rejects.toThrow("insufficient");
      first.release();
      await expect(route.prepare(c, params, "req-3")).resolves.toBeDefined();
    });

    it("a reservation is memory only: after a lock and a fresh unlock the outputs are selectable again", async () => {
      const store = createMemoryEngineStore();
      setUtxos([{ txid: funding(1, 50_000).txid, vout: 0, value: 50_000 }]);
      const c = ctx();
      await route.unlock(store, { warn: () => {} });
      await route.prepare(c, params, "req-1");
      route.lock();

      route = createBitcoinRoute();
      await route.unlock(store, { warn: () => {} });
      await expect(route.prepare(c, params, "req-2")).resolves.toBeDefined();
      await expect(store.collection("btc-utxos").get("state")).resolves.toBeUndefined();
    });

    it("a broadcast persists the lock under the transaction id", async () => {
      const store = createMemoryEngineStore();
      setUtxos([{ txid: funding(1, 50_000).txid, vout: 0, value: 50_000 }]);
      const c = ctx();
      await route.unlock(store, { warn: () => {} });
      const prepared = await route.prepare(c, params, "req-1");
      const tx = await prepared.submit(verify, () => undefined);
      await new Promise((resolve) => {
        setTimeout(resolve);
      });
      const raw = await store.collection("btc-utxos").get("state");
      const saved = JSON.parse(new TextDecoder().decode(raw)) as Record<
        string,
        { status: string; txId: string }
      >;
      expect(Object.values(saved).map((u) => [u.status, u.txId])).toStrictEqual([
        ["locked", tx.id],
      ]);

      route.lock();
      route = createBitcoinRoute();
      await route.unlock(store, { warn: () => {} });
      await expect(route.prepare(c, params, "req-2")).rejects.toThrow("insufficient");
    });

    it("concurrent prepares never select the same output", async () => {
      setUtxos([
        { txid: funding(1, 50_000).txid, vout: 0, value: 50_000 },
        { txid: funding(2, 50_000).txid, vout: 0, value: 50_000 },
      ]);
      const c = ctx();
      const [a, b] = await Promise.all([
        route.prepare(c, params, "req-1"),
        route.prepare(c, params, "req-2"),
      ]);
      await expect(route.prepare(c, params, "req-3")).rejects.toThrow("insufficient");
      a.release();
      b.release();
      const again = await route.prepare(c, params, "req-4");
      again.release();

      setUtxos([{ txid: funding(1, 50_000).txid, vout: 0, value: 50_000 }]);
      const results = await Promise.allSettled([
        route.prepare(c, params, "req-5"),
        route.prepare(c, params, "req-6"),
      ]);
      expect(results.map((r) => r.status).toSorted()).toStrictEqual(["fulfilled", "rejected"]);
    });

    it("a broadcast moves the lock to the transaction: the outputs stay reserved", async () => {
      setUtxos([{ txid: funding(1, 50_000).txid, vout: 0, value: 50_000 }]);
      const c = ctx();
      const prepared = await route.prepare(c, params, "req-1");
      const tx = await prepared.submit(verify, () => undefined);
      expect(tx.state).toBe("submitted");
      prepared.release();
      await expect(route.prepare(c, params, "req-2")).rejects.toThrow("insufficient");
    });

    it("a throwing commit broadcasts nothing and the released outputs are selectable again", async () => {
      setUtxos([{ txid: funding(1, 50_000).txid, vout: 0, value: 50_000 }]);
      const c = ctx();
      const prepared = await route.prepare(c, params, "req-1");
      const before = posted.length;
      await expect(
        prepared.submit(verify, () => {
          throw new Error("invalidated");
        }),
      ).rejects.toThrow("invalidated");
      expect(posted).toHaveLength(before);
      prepared.release();
      await expect(route.prepare(c, params, "req-2")).resolves.toBeDefined();
    });

    it("a failed replacement frees the extra input and the change index it reserved", async () => {
      /* The parent pays everything out — no own change — so the bump reserves a fresh change
         index plus a spare input, then dies inside the extra's raw-transaction read (the
         endpoint has no bytes for the txid). Both reservations must come back: a later send
         selects the same outpoint (the fetch error, not "insufficient") and hands out the same
         change index. */
      const stale = TXID(99);
      setUtxos([{ txid: funding(1, 50_000).txid, vout: 0, value: 50_000 }]);
      const c = ctx();
      const original = await send(c, 49_400n);
      expect(btcOf(original).outputs.every((o) => !o.own)).toBe(true);
      setUtxos([{ txid: stale, vout: 0, value: 30_000 }]);
      await expect(route.prepareReplace(c, original, "speed-up", "req-rbf")).rejects.toThrow(
        "Unexpected end of buffer",
      );

      hexCalls.length = 0;
      await expect(route.prepare(c, params, "req-next")).rejects.toThrow(
        "Unexpected end of buffer",
      );
      // The fetch was attempted — a still-reserved outpoint would have been skipped outright.
      expect(hexCalls).toContain(stale);

      setUtxos([{ txid: funding(2, 50_000).txid, vout: 0, value: 50_000 }]);
      const prepared = await route.prepare(c, params, "req-good");
      const tx = await prepared.submit(verify, () => undefined);
      expect(btcOf(tx).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR);
    });
  });

  describe("request-time checks and reservations", () => {
    const params = {
      account: {
        kind: "hd" as const,
        walletId: "w",
        groupIndex: 0,
        template: "btc.bip84" as const,
      },
      network: "bip122:000000000019d6689c085ae165831e93",
      to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      amount: 10_000n,
      fee: "slow" as const,
    };
    const verify = { kind: "password" as const, password: "pw" };
    const independentFees = (fast: number) => ({
      get: async (u: string) =>
        Promise.resolve(
          u === "/fee-estimates" ? { "1": fast, "3": fast, "6": fast, "144": 1 } : [],
        ),
      post: async () => Promise.resolve(TXID(9)),
    });

    it("cpfp records fee-above-network past 2x the independent fastest estimate", async () => {
      const c = ctx();
      const parent = await send(c);
      independentMode = { kind: "available", source: "host", client: independentFees(5) };
      const high = await route.prepareCpfp(c, parent, 11, "req-high");
      expect(high.checks).toContain("fee-above-network");
      high.release();
      const ok = await route.prepareCpfp(c, parent, 10, "req-ok");
      expect(ok.checks).not.toContain("fee-above-network");
      expect(ok.target).toBe(parent.id);
    });

    it("cpfp without an independent endpoint records reads-unverified", async () => {
      const c = ctx();
      const parent = await send(c);
      independentMode = { kind: "unavailable" };
      const prepared = await route.prepareCpfp(c, parent, 10, "req-1");
      expect(prepared.checks).toStrictEqual(["reads-unverified"]);
    });

    it("cpfp reserves the parent's outputs until released; a lock clears the reservation", async () => {
      const c = ctx();
      const parent = await send(c);
      const first = await route.prepareCpfp(c, parent, 10, "req-1");
      await expect(route.prepareCpfp(c, parent, 10, "req-2")).rejects.toThrow("already reserved");
      first.release();
      await route.prepareCpfp(c, parent, 10, "req-3");
      route.lock();
      await expect(route.prepareCpfp(c, parent, 10, "req-4")).resolves.toBeDefined();
    });

    it("a replacement reserves its extra inputs in memory; release frees them", async () => {
      setUtxos([
        { txid: funding(1, 50_000).txid, vout: 0, value: 50_000 },
        { txid: funding(2, 30_000).txid, vout: 0, value: 30_000 },
      ]);
      const c = ctx();
      const original = await send(c, 49_400n);
      const first = await route.prepareReplace(c, original, "speed-up", "req-1");
      const second = await route
        .prepareReplace(c, original, "speed-up", "req-2")
        .catch((error: unknown) => error);
      expect(second).toBeInstanceOf(Error);
      first.release();
      const third = await route.prepareReplace(c, original, "speed-up", "req-3");
      expect(third.target).toBe(original.id);
    });

    it("a replacement's fee floor applies after the independent merge", async () => {
      const c = ctx();
      const original = await send(c);
      independentMode = { kind: "available", source: "host", client: independentFees(1) };
      const prepared = await route.prepareReplace(c, original, "speed-up", "req-1");
      expect(prepared.checks).toContain("fee-mismatch");
      const bumped = await prepared.submit(verify, () => undefined);
      const old = btcOf(original);
      expect(btcOf(bumped).fee).toBeGreaterThanOrEqual(old.fee + old.vsize);
    });

    it("a replacement's fresh change pick stays reserved while the prepare lives", async () => {
      /* The parent pays everything out — no own change — so the bump takes a fresh change index.
         While that pick is held a send must step over it; releasing the bump hands the index
         back out. */
      const c = ctx();
      const original = await send(c, 49_400n);
      expect(btcOf(original).outputs.every((o) => !o.own)).toBe(true);
      const bump = await route.prepareReplace(c, original, "speed-up", "req-rbf");
      setUtxos([{ txid: funding(3, 50_000).txid, vout: 0, value: 50_000 }]);
      const held = await route.prepare(c, params, "req-held");
      const sent = await held.submit(verify, () => undefined);
      expect(btcOf(sent).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR_2);
      bump.release();
      setUtxos([{ txid: funding(4, 50_000).txid, vout: 0, value: 50_000 }]);
      const freed = await route.prepare(c, params, "req-freed");
      const sent2 = await freed.submit(verify, () => undefined);
      expect(btcOf(sent2).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR);
    });

    it("a CPFP child's fresh change pick stays reserved while the prepare lives", async () => {
      /* A send that runs while the child's pick is held must step over it; releasing the child
         hands the index back out. */
      const c = ctx();
      const parent = await send(c);
      const child = await route.prepareCpfp(c, parent, 10, "req-cpfp");
      setUtxos([{ txid: funding(3, 50_000).txid, vout: 0, value: 50_000 }]);
      const held = await route.prepare(c, params, "req-held");
      const sent = await held.submit(verify, () => undefined);
      expect(btcOf(sent).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR_2);
      child.release();
      setUtxos([{ txid: funding(4, 50_000).txid, vout: 0, value: 50_000 }]);
      const freed = await route.prepare(c, params, "req-freed");
      const sent2 = await freed.submit(verify, () => undefined);
      expect(btcOf(sent2).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR);
    });

    it("a failed CPFP build frees the change index it reserved", async () => {
      /* A target rate the child's inputs cannot pay makes the exact build throw inside the try,
         after the change pick is already reserved — the pick must come back for the next send. */
      const c = ctx();
      const parent = await send(c);
      await expect(route.prepareCpfp(c, parent, 1_000_000, "req-cpfp")).rejects.toThrow(
        "expected non-negative bigint",
      );
      const prepared = await route.prepare(c, params, "req-send");
      const sent = await prepared.submit(verify, () => undefined);
      expect(btcOf(sent).outputs.find((o) => o.own)?.address).toBe(CHANGE_ADDR);
    });
  });

  it("every segwit-v0 PSBT input carries its previous transaction, fetched for spent inputs only", async () => {
    setUtxos(DEFAULT_UTXOS);
    const c = ctx();
    signedCalls.length = 0;
    hexCalls.length = 0;
    const original = await send(c);
    const sendPsbt = signedPsbt(0);
    expect(sendPsbt.inputsLength).toBe(1);
    expect(sendPsbt.getInput(0).nonWitnessUtxo).toBeDefined();
    // Raws are fetched only for what a PSBT spends: the send selected one of the two utxos.
    expect(hexCalls).toStrictEqual([DEFAULT_UTXOS[0]!.txid]);
    hexCalls.length = 0;
    const child = await route.prepareCpfp(c, original, 10, "req-c");
    expect(hexCalls).toStrictEqual([original.hash]);
    await child.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(signedPsbt(1).getInput(0).nonWitnessUtxo).toBeDefined();
    hexCalls.length = 0;
    const bumped = await route.prepareReplace(c, original, "speed-up", "req-r");
    // The record persists txid/vout/value/address only — the prevouts are re-fetched for the
    // rebuild, exactly once per spent input.
    expect(hexCalls).toStrictEqual([DEFAULT_UTXOS[0]!.txid]);
    await bumped.submit({ kind: "password", password: "pw" }, () => undefined);
    const bumpPsbt = signedPsbt(2);
    for (let i = 0; i < bumpPsbt.inputsLength; i++) {
      expect(bumpPsbt.getInput(i).nonWitnessUtxo).toBeDefined();
    }
  });

  it("a replacement spends only the original's inputs — never unselected utxos", async () => {
    signedCalls.length = 0;
    setUtxos([
      { txid: funding(1, 50_000).txid, vout: 0, value: 50_000 },
      { txid: funding(2, 30_000).txid, vout: 0, value: 30_000 },
      { txid: funding(3, 40_000).txid, vout: 0, value: 40_000 },
    ]);
    const c = ctx();
    const original = await send(c);
    const originalInputs = signedPsbt(0).inputsLength;
    expect(originalInputs).toBe(1);
    const speedUp = await route.prepareReplace(c, original, "speed-up", "req-speed-up");
    await speedUp.submit({ kind: "password", password: "pw" }, () => undefined);
    const cancel = await route.prepareReplace(c, original, "cancel", "req-cancel");
    await cancel.submit({ kind: "password", password: "pw" }, () => undefined);
    for (const n of [1, 2] as const) {
      const tx = signedPsbt(n);
      const txids = new Set(inputTxids(tx));
      // Exactly the original's inputs, each once — unselected utxos and duplicates are bugs.
      expect(tx.inputsLength).toBe(originalInputs);
      expect(txids.size).toBe(tx.inputsLength);
    }
  });

  it("fee bumps keep the original account's groupIndex", async () => {
    signedCalls.length = 0;
    setUtxos(DEFAULT_UTXOS);
    const c = ctx();
    const original = await routeSend(route, c, {
      account: { kind: "hd", walletId: "w", groupIndex: 1, template: "btc.bip84" },
      network: "bip122:000000000019d6689c085ae165831e93",
      to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      amount: 10_000n,
      fee: "slow",
      verify: { kind: "password", password: "pw" },
    });
    expect(signGroupIndex(0)).toBe(1);
    const bumped = await route.prepareReplace(c, original, "speed-up", "req-r");
    await bumped.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(signGroupIndex(1)).toBe(1);
    const child = await route.prepareCpfp(c, original, 10, "req-c");
    await child.submit({ kind: "password", password: "pw" }, () => undefined);
    expect(signGroupIndex(2)).toBe(1);
  });
});
