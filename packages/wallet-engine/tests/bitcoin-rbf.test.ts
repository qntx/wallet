import { HDKey } from "@scure/bip32";
import { NETWORK, p2wpkh, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { scripthash } from "../src/chains/bitcoin-scan.ts";
import { createBitcoinRoute } from "../src/transactions/bitcoin.ts";
import type { RouteContext, TrackedTransaction, SignParams } from "../src/transactions/route.ts";

const HD = HDKey.fromMasterSeed(new Uint8Array(64).fill(1)).derive("m/84'/0'/0'");
const PUB = HD.deriveChild(0).deriveChild(0);
const TO_ADDR = p2wpkh(PUB.publicKey!, NETWORK).address;
const CHANGE_ADDR = p2wpkh(HD.deriveChild(1).deriveChild(0).publicKey!, NETWORK).address;
const TXID = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const { script } = p2wpkh(PUB.publicKey!, NETWORK);

const OUR_HASH = scripthash(TO_ADDR, NETWORK);
const DEFAULT_UTXOS = [
  { txid: TXID(1), vout: 0, value: 50_000 },
  { txid: TXID(2), vout: 0, value: 30_000 },
];
let utxoList = [...DEFAULT_UTXOS];
const setUtxos = (list: ReadonlyArray<{ txid: string; vout: number; value: number }>): void => {
  utxoList = [...list];
};
const get = (url: string): unknown => {
  const sh = /^\/scripthash\/([0-9a-f]{64})\/(txs|utxo)$/.exec(url);
  if (sh !== null) {
    if (sh[1] !== OUR_HASH) {
      return [];
    }
    return sh[2] === "txs" ? utxoList.map((u) => ({ txid: u.txid })) : utxoList;
  }
  if (url === "/fee-estimates") {
    return { "1": 20, "3": 10, "6": 5, "144": 1 };
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
const esploraStub = {
  get: async (u: string) => Promise.resolve(get(u)),
  post: async () => Promise.resolve(TXID(9)),
};

const signedCalls: SignParams[] = [];
const route = createBitcoinRoute();
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
    networks: { esplora: () => esploraStub } as never,
    wallet: {} as never,
    openStore: async () => Promise.resolve({} as never),
    random: (n: number) => new Uint8Array(n).fill(0xaa),
    setTimer: () => () => {},
    now: () => 0,
    logger: { warn: () => {} },
    chains: {
      account: async () =>
        Promise.resolve({
          template: "btc.bip84",
          network: "bip122:000000000019d6689c085ae165831e93",
          xpub: HD.publicExtendedKey,
          fingerprint: "00000000",
          path: "m/84'/0'/0'",
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
  newId: nextId,
});

const send = async (c: RouteContext, amount = 10_000n): Promise<TrackedTransaction> => {
  setUtxos(DEFAULT_UTXOS);
  return route.send(c, {
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "btc.bip84" },
    network: "bip122:000000000019d6689c085ae165831e93",
    to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    amount,
    fee: "slow",
    verify: { kind: "password", password: "pw" },
  });
};

describe("bitcoin rbf", () => {
  it("cancel sends all inputs to the next change address", async () => {
    const c = ctx();
    const original = await send(c);
    const cancelled = await route.replace(c, original, "cancel", {
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

  it("speed-up bumps the fee (BIP-125 rule 4: fee + vsize) and keeps payee outputs", async () => {
    const c = ctx();
    const original = await send(c);
    const bumped = await route.replace(c, original, "speed-up", {
      kind: "password",
      password: "pw",
    });
    expect(bumped.replaces).toBe(original.id);
    const payees = btcOf(bumped).outputs.filter((o) => !o.own);
    expect(payees.length).toBeGreaterThan(0);
    const before = btcOf(original);
    expect(btcOf(bumped).fee).toBeGreaterThanOrEqual(before.fee + before.vsize);
  });

  it("bumpChild builds a CPFP child spending our own outputs", async () => {
    const c = ctx();
    const parent = await send(c);
    const child = await route.bumpChild(c, parent, 10, { kind: "password", password: "pw" });
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
    const bumped = await route.replace(c, original, "speed-up", {
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
      { txid: TXID(1), vout: 0, value: 50_000 },
      { txid: TXID(2), vout: 0, value: 30_000 },
    ]);
    const c = ctx();
    const original = await send(c, 49_400n);
    const bumped = await route.replace(c, original, "speed-up", {
      kind: "password",
      password: "pw",
    });
    expect(btcOf(bumped).inputs.length).toBeGreaterThan(btcOf(original).inputs.length);
  });

  it("fails before signing when the bump is unfundable", async () => {
    setUtxos([{ txid: TXID(1), vout: 0, value: 6000 }]);
    const c = ctx();
    const original = await route.send(c, {
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "btc.bip84" },
      network: "bip122:000000000019d6689c085ae165831e93",
      to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      amount: 5400n,
      fee: "slow",
      verify: { kind: "password", password: "pw" },
    });
    const before = signedCalls.length;
    await expect(
      route.replace(c, original, "speed-up", { kind: "password", password: "pw" }),
    ).rejects.toThrow("insufficient");
    expect(signedCalls).toHaveLength(before);
  });
});
