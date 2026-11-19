/**
 * Inscription/rune protection (ord's postage rule): every taproot output and every output at or
 * below 20_000 sat may carry an inscription, so it is shown as protected, excluded from wallet-send
 * coin selection unless named in `inputs`, and flagged in dApp PSBT risk. Assertions go through the
 * public surfaces — `readBitcoin`, the route, `assessBitcoinPsbts` — so this file exercises the
 * same code on the pre-policy implementation.
 */
import { hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { NETWORK, p2tr, p2wpkh, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { readBitcoin } from "../src/assets/bitcoin.ts";
import { scripthash } from "../src/chains/bitcoin-scan.ts";
import { assessBitcoinPsbts } from "../src/requests/risk.ts";
import { createBitcoinRoute } from "../src/transactions/bitcoin.ts";
import type { RouteContext, SignParams } from "../src/transactions/route.ts";
import { routeCpfp, routeSend } from "./send-helpers.ts";

const SEED = new Uint8Array(64).fill(1);
const HD84 = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'");
const HD86 = HDKey.fromMasterSeed(SEED).derive("m/86'/0'/0'");
const NET = "bip122:000000000019d6689c085ae165831e93";
const TO84 = p2wpkh(HD84.deriveChild(0).deriveChild(0).publicKey!, NETWORK).address;
const TO86 = p2tr(
  HD86.deriveChild(0).deriveChild(0).publicKey!.slice(1),
  undefined,
  NETWORK,
).address;
const TXID = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

// -- readBitcoin surface -----------------------------------------------------

const esploraFor = (address: string, utxos: ReadonlyArray<unknown>) => {
  const hash = scripthash(address, NETWORK);
  return {
    get: async (path: string) => Promise.resolve(path === `/scripthash/${hash}/utxo` ? utxos : []),
    post: async () => Promise.reject(new Error("no broadcast")),
  };
};

const utxoJson = (txid: string, vout: number, value: number, height = 800_000): unknown => ({
  txid,
  vout,
  value,
  status: { block_height: height },
});

describe("protected balances (ord postage rule)", () => {
  it("every value at or below 20_000 sat is protected; 20_001 is spendable", async () => {
    const utxos = [
      utxoJson(TXID(1), 0, 546),
      utxoJson(TXID(2), 0, 330),
      utxoJson(TXID(3), 0, 10_000),
      utxoJson(TXID(4), 0, 20_000),
      utxoJson(TXID(5), 0, 20_001),
    ];
    const read = await readBitcoin(esploraFor(TO84, utxos), NET, [
      { kind: "address", address: TO84 },
    ]);
    expect(read.totals).toStrictEqual({ native: "20001", unconfirmed: "0", protected: "30876" });
    expect(read.utxos.map((u) => u.protected)).toStrictEqual([true, true, true, true, false]);
  });

  it("a taproot output of any value is protected", async () => {
    const read = await readBitcoin(esploraFor(TO86, [utxoJson(TXID(6), 0, 1_000_000)]), NET, [
      { kind: "address", address: TO86 },
    ]);
    expect(read.totals).toStrictEqual({
      native: "0",
      unconfirmed: "0",
      protected: "1000000",
    });
    expect(read.utxos[0]?.protected).toBe(true);
  });
});

// -- route surface -----------------------------------------------------------

const PREVS = new Map<string, Uint8Array>();
const { script: script84 } = p2wpkh(HD84.deriveChild(0).deriveChild(0).publicKey!, NETWORK);
const { script: script86 } = p2tr(
  HD86.deriveChild(0).deriveChild(0).publicKey!.slice(1),
  undefined,
  NETWORK,
);

const funding = (
  seed: number,
  value: number,
  script: Uint8Array,
): { txid: string; raw: Uint8Array } => {
  const prev = new Transaction({ version: 2 });
  prev.addInput({ txid: TXID(seed), index: 0, sequence: 0xffffffff });
  prev.addOutput({ script, amount: BigInt(value) });
  const raw = prev.toBytes(true, false);
  PREVS.set(prev.id, raw);
  return { txid: prev.id, raw };
};

type Template = "btc.bip84" | "btc.bip86";

const rig = (template: Template) => {
  const hd = template === "btc.bip86" ? HD86 : HD84;
  const address = template === "btc.bip86" ? TO86 : TO84;
  const script = template === "btc.bip86" ? script86 : script84;
  const hash = scripthash(address, NETWORK);
  let utxoList: Array<{ txid: string; vout: number; value: number }> = [];
  const signedCalls: SignParams[] = [];
  const get = (url: string): unknown => {
    const sh = /^\/scripthash\/([0-9a-f]{64})\/(txs|utxo)$/.exec(url);
    if (sh !== null) {
      if (sh[1] !== hash) {
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
            scriptpubkey_address: address,
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
    post: async (_u: string, body: string) => {
      const raw = new Uint8Array(Buffer.from(body, "hex"));
      const { id } = Transaction.fromRaw(raw, { allowUnknownInputs: true });
      PREVS.set(id, raw);
      return Promise.resolve(id);
    },
  };
  const ctx = (): RouteContext => ({
    options: {
      networks: {
        esplora: () => esploraStub,
        independentEsplora: () => ({ kind: "not-needed" }),
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
            template,
            network: NET,
            groupIndex: p.groupIndex,
            xpub: hd.publicExtendedKey,
            fingerprint: "00000000",
            path: template === "btc.bip86" ? "m/86'/0'/0'" : "m/84'/0'/0'",
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
            const key = hd.deriveChild(path.at(-2) ?? 0).deriveChild(path.at(-1) ?? 0);
            tx.signIdx(key.privateKey!, i);
          }
          return Promise.resolve({ kind: "bitcoin.psbt", signedPsbt: tx.toPSBT() });
        },
      } as never,
    },
    transition: async (tx, next) => Promise.resolve({ ...tx, ...next }),
    track: () => {},
    txs: () => ({}),
    newId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `tx-${n}`;
      };
    })(),
  });
  const route = createBitcoinRoute();
  const inputTxids = (): string[] => {
    const req = signedCalls.at(-1)?.request;
    if (req === undefined || req.kind !== "bitcoin.psbt") {
      throw new Error("expected a bitcoin.psbt sign call");
    }
    const tx = Transaction.fromPSBT(req.psbt);
    return Array.from({ length: tx.inputsLength }, (_, i) =>
      hex.encode(Uint8Array.from(tx.getInput(i).txid as Uint8Array)),
    );
  };
  return {
    ctx,
    route,
    inputTxids,
    send: async (amount: bigint, inputs?: ReadonlyArray<string>) =>
      routeSend(route, ctx(), {
        account: { kind: "hd", walletId: "w", groupIndex: 0, template },
        network: NET,
        to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        amount,
        fee: "slow",
        ...(inputs === undefined ? {} : { inputs }),
        verify: { kind: "password", password: "pw" },
      }),
    fund: (seed: number, value: number): string => {
      const { txid } = funding(seed, value, script);
      utxoList = [...utxoList, { txid, vout: 0, value }];
      return txid;
    },
  };
};

describe("wallet sends never take inscription-risk UTXOs", () => {
  it("a bip84 account holding 10_000 + 100_000 sends without the 10_000 input", async () => {
    const r = rig("btc.bip84");
    const small = r.fund(1, 10_000);
    const big = r.fund(2, 100_000);
    await r.send(5000n);
    expect(r.inputTxids()).toStrictEqual([big]);
    expect(r.inputTxids()).not.toContain(small);
  });

  it("a bip84 account holding only a 10_000-sat UTXO cannot send", async () => {
    const r = rig("btc.bip84");
    r.fund(1, 10_000);
    await expect(r.send(5000n)).rejects.toThrow("insufficient");
  });

  it("a bip86 account cannot send without naming inputs — every taproot output is protected", async () => {
    const r = rig("btc.bip86");
    r.fund(1, 50_000);
    await expect(r.send(10_000n)).rejects.toThrow("insufficient");
  });

  it("a named protected outpoint is spent: `inputs` opts the bip86 coin in", async () => {
    const r = rig("btc.bip86");
    const txid = r.fund(1, 50_000);
    await r.send(10_000n, [`${txid}:0`]);
    expect(r.inputTxids()).toStrictEqual([txid]);
  });

  it("naming an outpoint that is not among the account's utxos throws", async () => {
    const r = rig("btc.bip84");
    r.fund(1, 100_000);
    const unknown = `${TXID(99)}:0`;
    await expect(r.send(5000n, [unknown])).rejects.toThrow(
      `${unknown} is not a spendable output of this account`,
    );
  });
});

describe("cpfp still spends the parent's own small outputs", () => {
  it("builds a child over a ≤20_000-sat own change output", async () => {
    const r = rig("btc.bip84");
    r.fund(1, 25_000);
    const parent = await r.send(5000n);
    const child = await routeCpfp(r.route, r.ctx(), parent, 10, {
      kind: "password",
      password: "pw",
    });
    expect(child.parentId).toBe(parent.id);
  });
});

describe("dApp PSBT risk follows the same rule", () => {
  it("a 10_000-sat bip84 input signed ALL is an inscription danger", () => {
    expect(
      assessBitcoinPsbts([{ value: 10_000, template: "btc.bip84", sigHash: "ALL", frozen: false }]),
    ).toStrictEqual([{ code: "bitcoin-inscription-input", level: "danger" }]);
  });

  it("a bip86 input is a danger at any value — the ordinals account itself", () => {
    expect(
      assessBitcoinPsbts([
        { value: 100_000, template: "btc.bip86", sigHash: "ALL", frozen: false },
      ]),
    ).toStrictEqual([{ code: "bitcoin-inscription-input", level: "danger" }]);
    expect(
      assessBitcoinPsbts([
        { value: 1_000_000, template: "btc.bip86", sigHash: "SINGLE|ANYONECANPAY", frozen: false },
      ]),
    ).toStrictEqual([
      { code: "bitcoin-sighash-single", level: "danger" },
      { code: "bitcoin-inscription-input", level: "warning" },
    ]);
  });

  it("an ordinary bip84 input raises nothing", () => {
    expect(
      assessBitcoinPsbts([{ value: 30_000, template: "btc.bip84", sigHash: "ALL", frozen: false }]),
    ).toStrictEqual([]);
  });

  it("a frozen input is a danger finding", () => {
    expect(
      assessBitcoinPsbts([{ value: 30_000, template: "btc.bip84", sigHash: "ALL", frozen: true }]),
    ).toStrictEqual([{ code: "bitcoin-frozen-input", level: "danger" }]);
  });
});
