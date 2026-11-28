import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NETWORK, p2tr, p2wpkh, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import type { BitcoinTemplate } from "@qntx/wallet-chains";
import { decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import type { ChainAccount } from "@qntx/wallet/chains";

import { prepareDappPsbts, signDappPsbts } from "../src/chains/bitcoin-dapp.ts";
import type { Esplora } from "../src/chains/bitcoin.ts";
import { assessWarnings } from "../src/requests/risk.ts";
import type { BitcoinPsbtInput } from "../src/requests/types.ts";
import type { ChainApis } from "../src/transactions/route.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MAINNET = "bip122:000000000019d6689c085ae165831e93";
const PAYEE_SCRIPT = p2wpkh(
  HDKey.fromMasterSeed(new Uint8Array(64).fill(3)).derive("m/0/0").publicKey!,
  NETWORK,
).script;

const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const nodeOf = (template: BitcoinAccountTemplate, chain: number, index: number) =>
  master.derive(`m/${template === "btc.bip86" ? 86 : 84}'/0'/0'/${chain}/${index}`);
const scriptOf = (template: BitcoinAccountTemplate, chain = 0, index = 0): Uint8Array =>
  template === "btc.bip86"
    ? p2tr(nodeOf(template, chain, index).publicKey!.slice(1)).script
    : p2wpkh(nodeOf(template, chain, index).publicKey!).script;

const PURPOSE: Record<BitcoinTemplate, number> = {
  "btc.bip44": 44,
  "btc.bip49": 49,
  "btc.bip84": 84,
  "btc.bip86": 86,
};
const accountFor = (template: BitcoinTemplate): ChainAccount => ({
  template,
  network: MAINNET,
  xpub: master.derive(`m/${PURPOSE[template]}'/0'/0'`).publicExtendedKey,
  fingerprint: master.fingerprint.toString(16).padStart(8, "0"),
  path: `m/${PURPOSE[template]}'/0'/0'`,
  changeMark: 0,
  confirmed: true,
});

/** Raw previous transactions the mock esplora serves by txid — registered per input below. */
const PREVS = new Map<string, Uint8Array>();

/** A dApp PSBT: prevouts carry no derivation — the engine is expected to add it. */
const dappPsbt = (
  inputs: ReadonlyArray<{ script: Uint8Array; amount: bigint; lie?: bigint }>,
  outputs: ReadonlyArray<{ script: Uint8Array; amount: bigint }>,
): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  for (const [i, input] of inputs.entries()) {
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({ txid: new Uint8Array(32).fill(i + 1), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: input.script, amount: input.amount });
    const raw = prev.toBytes(true, false);
    PREVS.set(prev.id, raw);
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: input.script, amount: input.lie ?? input.amount },
    });
  }
  for (const output of outputs) {
    tx.addOutput(output);
  }
  return tx.toPSBT(0);
};

const rig = () => {
  const calls: string[] = [];
  const es: Esplora = {
    get: async (path: string) => {
      calls.push(path);
      const m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path);
      if (m !== null) {
        return Promise.resolve(Buffer.from(PREVS.get(m[1] ?? "") ?? []).toString("hex"));
      }
      return Promise.resolve([]);
    },
    post: async () => Promise.resolve(""),
  };
  const apis = {
    account: async (params: { template: string }): Promise<ChainAccount> =>
      Promise.resolve(
        params.template.startsWith("btc.")
          ? accountFor(params.template as BitcoinTemplate)
          : { template: "evm.bip44", network: "eip155:1", address: "0x0", confirmed: true },
      ),
  };
  return { es, apis, calls };
};

const apisWithMark = (changeMark: number) => ({
  account: async (params: { template: string }): Promise<ChainAccount> =>
    Promise.resolve(
      params.template.startsWith("btc.")
        ? { ...accountFor(params.template as BitcoinTemplate), changeMark }
        : { template: "evm.bip44", network: "eip155:1", address: "0x0", confirmed: true },
    ),
});

const GROUP = { walletId: "w", groupIndex: 0 };
const signEntry = (
  index: number,
  template: "btc.bip84" | "btc.bip86",
): BitcoinPsbtInput["sign"][number] => ({ index, sigHash: "ALL", template });

describe("prepareDappPsbts", () => {
  it(
    "binds each input to its own template and marks own outputs in one mixed PSBT",
    { timeout: 20_000 },
    async () => {
      const { es, apis } = rig();
      const psbt = dappPsbt(
        [
          { script: scriptOf("btc.bip84"), amount: 100000n },
          { script: scriptOf("btc.bip86"), amount: 30000n },
        ],
        [
          { script: PAYEE_SCRIPT, amount: 90000n },
          { script: scriptOf("btc.bip86"), amount: 30000n },
        ],
      );
      const [prepared] = await prepareDappPsbts(
        apis,
        es,
        GROUP,
        MAINNET,
        [{ psbt, sign: [signEntry(0, "btc.bip84"), signEntry(1, "btc.bip86")] }],
        new Set<string>(),
      );
      expect(prepared).toBeDefined();
      const tx = Transaction.fromPSBT(prepared!.request.psbt);
      expect(tx.getInput(0).bip32Derivation?.[0]?.[1].path.join(",")).toBe(
        "2147483732,2147483648,2147483648,0,0",
      );
      const outDer = tx.getOutput(1).tapBip32Derivation;
      expect(outDer).toBeDefined();
      // The ordinals output is the group's own receive key: not discoverable change, so it is
      // shown at its path rather than hidden.
      expect(prepared!.own.unusual.get(Buffer.from(scriptOf("btc.bip86")).toString("hex"))).toBe(
        "m/86'/0'/0'/0/0",
      );
      expect(prepared!.request.account).toStrictEqual({
        kind: "hd",
        walletId: "w",
        groupIndex: 0,
      });
      expect(prepared!.request.sign).toStrictEqual([
        { index: 0, template: "btc.bip84" },
        { index: 1, template: "btc.bip86" },
      ]);
    },
  );

  it(
    "refuses an entry whose template disagrees with the prevout's owning template",
    { timeout: 20_000 },
    async () => {
      const { es, apis } = rig();
      const psbt = dappPsbt(
        [{ script: scriptOf("btc.bip86"), amount: 30000n }],
        [{ script: PAYEE_SCRIPT, amount: 29000n }],
      );
      await expect(
        prepareDappPsbts(
          apis,
          es,
          GROUP,
          MAINNET,
          [{ psbt, sign: [signEntry(0, "btc.bip84")] }],
          new Set<string>(),
        ),
      ).rejects.toMatchObject({
        code: "invalid-request",
        message: "input 0 is not this account's",
      });
      await expect(
        prepareDappPsbts(
          apis,
          es,
          GROUP,
          MAINNET,
          [{ psbt, sign: [signEntry(0, "btc.bip86")] }],
          new Set<string>(),
        ),
      ).resolves.toBeDefined();
    },
  );

  it("scans only templates the batch signs", { timeout: 20_000 }, async () => {
    const { es, apis, calls } = rig();
    const psbt = dappPsbt(
      [{ script: scriptOf("btc.bip84"), amount: 100000n }],
      [{ script: PAYEE_SCRIPT, amount: 90000n }],
    );
    await prepareDappPsbts(
      apis,
      es,
      GROUP,
      MAINNET,
      [{ psbt, sign: [signEntry(0, "btc.bip84")] }],
      new Set<string>(),
    );
    const paymentOnly = calls.length;
    // 41 scan calls (20 receive + 21 change to the mark's reach) + the input's previous tx.
    expect(paymentOnly).toBe(42);

    calls.length = 0;
    const both = dappPsbt(
      [
        { script: scriptOf("btc.bip84"), amount: 100000n },
        { script: scriptOf("btc.bip86"), amount: 30000n },
      ],
      [{ script: PAYEE_SCRIPT, amount: 120000n }],
    );
    await prepareDappPsbts(
      apis,
      es,
      GROUP,
      MAINNET,
      [{ psbt: both, sign: [signEntry(0, "btc.bip84"), signEntry(1, "btc.bip86")] }],
      new Set<string>(),
    );
    expect(calls).toHaveLength(84);
  });

  it(
    "hides own change only up to the reported mark's reach — past it the script is foreign",
    { timeout: 20_000 },
    async () => {
      const change25 = scriptOf("btc.bip84", 1, 25);
      const changeHex = Buffer.from(change25).toString("hex");
      const psbt = dappPsbt(
        [{ script: scriptOf("btc.bip84"), amount: 100000n }],
        [
          { script: PAYEE_SCRIPT, amount: 90000n },
          { script: change25, amount: 9000n },
        ],
      );
      const { es } = rig();
      const apis = apisWithMark;
      // Mark 0 reaches index 20 — /1/25 is beyond the wallet's scan, so it stays foreign:
      // neither hidden change nor a shown unusual own output.
      const [low] = await prepareDappPsbts(
        apis(0),
        es,
        GROUP,
        MAINNET,
        [{ psbt, sign: [signEntry(0, "btc.bip84")] }],
        new Set<string>(),
      );
      expect(low!.own.change.has(changeHex)).toBe(false);
      expect(low!.own.unusual.has(changeHex)).toBe(false);
      // Mark 10 reaches index 30 — the same output is discoverable change and hides.
      const [high] = await prepareDappPsbts(
        apis(10),
        es,
        GROUP,
        MAINNET,
        [{ psbt, sign: [signEntry(0, "btc.bip84")] }],
        new Set<string>(),
      );
      expect(high!.own.change.has(changeHex)).toBe(true);
      expect(high!.own.unusual.has(changeHex)).toBe(false);
    },
  );

  it(
    "hides own change exactly at the mark's bound and shows mark + 21 as unusual",
    { timeout: 20_000 },
    async () => {
      /* Mark 0's reach is index 20: /1/20 sits in the scanned change chain, so the engine binds
         it and hides it as change. /1/21 lies one past the scan — the engine never binds it, so
         a derivation the dApp itself attached is what `ownOutputTail` reads: the output is own
         but not discoverable, and shows at its path rather than hiding. */
      const atBound = scriptOf("btc.bip84", 1, 20);
      const pastBound = scriptOf("btc.bip84", 1, 21);
      const deep = nodeOf("btc.bip84", 1, 21);
      const tx = Transaction.fromPSBT(
        dappPsbt(
          [{ script: scriptOf("btc.bip84"), amount: 100_000n }],
          [
            { script: PAYEE_SCRIPT, amount: 80_000n },
            { script: atBound, amount: 5000n },
            { script: pastBound, amount: 5000n },
          ],
        ),
      );
      tx.updateOutput(2, {
        bip32Derivation: [
          [
            deep.publicKey!,
            {
              fingerprint: master.fingerprint,
              path: [0x80000054, 0x80000000, 0x80000000, 1, 21],
            },
          ],
        ],
      });
      const { es } = rig();
      const [prepared] = await prepareDappPsbts(
        apisWithMark(0),
        es,
        GROUP,
        MAINNET,
        [{ psbt: tx.toPSBT(0), sign: [signEntry(0, "btc.bip84")] }],
        new Set<string>(),
      );
      const atBoundHex = Buffer.from(atBound).toString("hex");
      const pastBoundHex = Buffer.from(pastBound).toString("hex");
      expect(prepared!.own.change.has(atBoundHex)).toBe(true);
      expect(prepared!.own.change.has(pastBoundHex)).toBe(false);
      expect(prepared!.own.unusual.get(pastBoundHex)).toBe("m/84'/0'/0'/1/21");
    },
  );

  it(
    "a signed change input never raises the dApp preview's own mark",
    { timeout: 20_000 },
    async () => {
      const { es } = rig();
      /* The PSBT spends own change /1/25 (inside mark-10's reach) and binds a derivation
         claiming an output to the wallet's own /1/45 — a real own address the preview must
         show, not hide: under the external origin the signed input proves nothing about the
         wallet's own scan reach. */
      const deep = nodeOf("btc.bip84", 1, 45);
      const change45 = p2wpkh(deep.publicKey!, NETWORK).script;
      const tx = Transaction.fromPSBT(
        dappPsbt(
          [{ script: scriptOf("btc.bip84", 1, 25), amount: 100_000n }],
          [
            { script: PAYEE_SCRIPT, amount: 90_000n },
            { script: change45, amount: 9000n },
          ],
        ),
      );
      tx.updateOutput(1, {
        bip32Derivation: [
          [
            deep.publicKey!,
            {
              fingerprint: master.fingerprint,
              path: [0x80000054, 0x80000000, 0x80000000, 1, 45],
            },
          ],
        ],
      });
      const [prepared] = await prepareDappPsbts(
        apisWithMark(10),
        es,
        GROUP,
        MAINNET,
        [{ psbt: tx.toPSBT(0), sign: [signEntry(0, "btc.bip84")] }],
        new Set<string>(),
      );
      const hex45 = Buffer.from(change45).toString("hex");
      // Mark 10 bounds discoverable change at index 30 — /1/45 stays a shown own-path outflow.
      expect(prepared!.own.change.has(hex45)).toBe(false);
      expect(prepared!.own.unusual.get(hex45)).toBe("m/84'/0'/0'/1/45");
      // The request the kernel signs carries the external origin — a dApp spends, never marks.
      expect(prepared!.request.origin).toBe("external");
    },
  );

  it("rejects a witnessUtxo that lies about the chain prevout", { timeout: 20_000 }, async () => {
    const { es, apis } = rig();
    const psbt = dappPsbt(
      [{ script: scriptOf("btc.bip84"), amount: 100000n, lie: 99999n }],
      [{ script: PAYEE_SCRIPT, amount: 90000n }],
    );
    await expect(
      prepareDappPsbts(
        apis,
        es,
        GROUP,
        MAINNET,
        [{ psbt, sign: [signEntry(0, "btc.bip84")] }],
        new Set<string>(),
      ),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "input 0 amount or script does not match the chain",
    });
  });

  it(
    "attaches the chain prevout: nonWitnessUtxo for bip84, witnessUtxo for both",
    {
      timeout: 20_000,
    },
    async () => {
      const { es, apis } = rig();
      const psbt = dappPsbt(
        [
          { script: scriptOf("btc.bip84"), amount: 100000n },
          { script: scriptOf("btc.bip86"), amount: 30000n },
        ],
        [{ script: PAYEE_SCRIPT, amount: 120000n }],
      );
      const [prepared] = await prepareDappPsbts(
        apis,
        es,
        GROUP,
        MAINNET,
        [{ psbt, sign: [signEntry(0, "btc.bip84"), signEntry(1, "btc.bip86")] }],
        new Set<string>(),
      );
      const tx = Transaction.fromPSBT(prepared!.request.psbt);
      expect(tx.getInput(0).nonWitnessUtxo).toBeDefined();
      expect(tx.getInput(0).witnessUtxo?.amount).toBe(100000n);
      expect(tx.getInput(1).witnessUtxo?.amount).toBe(30000n);
    },
  );

  it(
    "rejects a bip86 witnessUtxo amount that disagrees with the chain",
    {
      timeout: 20_000,
    },
    async () => {
      const { es, apis } = rig();
      const psbt = dappPsbt(
        [{ script: scriptOf("btc.bip86"), amount: 30000n, lie: 40000n }],
        [{ script: PAYEE_SCRIPT, amount: 29000n }],
      );
      await expect(
        prepareDappPsbts(
          apis,
          es,
          GROUP,
          MAINNET,
          [{ psbt, sign: [signEntry(0, "btc.bip86")] }],
          new Set<string>(),
        ),
      ).rejects.toMatchObject({ code: "invalid-request" });
    },
  );
});

const signPsbt: ChainApis["sign"] = async ({ request }) => {
  if (request.kind !== "bitcoin.psbt") {
    throw new Error("unexpected kind");
  }
  const tx = Transaction.fromPSBT(request.psbt);
  for (const entry of request.sign) {
    const path = tx.getInput(entry.index).bip32Derivation?.[0]?.[1].path;
    if (path === undefined) {
      throw new Error("missing derivation");
    }
    const node = nodeOf(entry.template, path.at(-2) ?? 0, path.at(-1) ?? 0);
    tx.signIdx(node.privateKey!, entry.index);
  }
  return Promise.resolve({ kind: "bitcoin.psbt" as const, signedPsbt: tx.toPSBT(0) });
};

describe("signDappPsbts", () => {
  it("a throwing commit prevents the broadcast", { timeout: 20_000 }, async () => {
    const { es, apis } = rig();
    const psbt = dappPsbt(
      [{ script: scriptOf("btc.bip84"), amount: 100000n }],
      [{ script: PAYEE_SCRIPT, amount: 90000n }],
    );
    const [prepared] = await prepareDappPsbts(
      apis,
      es,
      GROUP,
      MAINNET,
      [{ psbt, sign: [signEntry(0, "btc.bip84")] }],
      new Set<string>(),
    );
    const posted: string[] = [];
    const signing: Pick<ChainApis, "sign"> = { sign: signPsbt };
    await expect(
      signDappPsbts(
        signing,
        [prepared!],
        true,
        { kind: "password", password: "pw" },
        () => {
          throw new Error("invalidated");
        },
        async () => {
          posted.push("broadcast");
          return Promise.resolve("txid");
        },
      ),
    ).rejects.toThrow("invalidated");
    expect(posted).toHaveLength(0);
  });
});

/* A pinned entry the device never confirmed is not own: its own-key outputs are unconfirmed —
   never hidden, never worded as an own path — the preview carries the danger finding and the
   sign call carries the acknowledgement the kernel demands. */
describe("an unconfirmed template's outputs are never own", () => {
  const apisUnconfirmed = {
    account: async (params: { template: string }): Promise<ChainAccount> =>
      Promise.resolve(
        params.template.startsWith("btc.")
          ? {
              ...accountFor(params.template as BitcoinTemplate),
              confirmed: params.template !== "btc.bip84",
            }
          : { template: "evm.bip44", network: "eip155:1", address: "0x0", confirmed: true },
      ),
  };

  it(
    "classifies its output unconfirmed, warns danger, and acknowledges on sign",
    { timeout: 20_000 },
    async () => {
      const { es } = rig();
      const change = scriptOf("btc.bip84", 1, 0);
      const changeHex = Buffer.from(change).toString("hex");
      const psbt = dappPsbt(
        [{ script: scriptOf("btc.bip84"), amount: 100_000n }],
        [
          { script: PAYEE_SCRIPT, amount: 80_000n },
          { script: change, amount: 15_000n },
        ],
      );
      const [prepared] = await prepareDappPsbts(
        apisUnconfirmed,
        es,
        GROUP,
        MAINNET,
        [{ psbt, sign: [signEntry(0, "btc.bip84")] }],
        new Set<string>(),
      );
      /* What a confirmed entry hides as change is foreign under an unconfirmed one — the bound
         derivation stays so the kernel raises the same warning. */
      expect(prepared!.own.change.has(changeHex)).toBe(false);
      expect(prepared!.own.unusual.has(changeHex)).toBe(false);
      expect(prepared!.own.unconfirmed.has(changeHex)).toBe(true);
      const bound = Transaction.fromPSBT(prepared!.request.psbt).getOutput(1);
      expect(bound.bip32Derivation?.[0]?.[1].path.at(-1)).toBe(0);

      // The preview intent warns danger; the risk table turns it into the finding approve gates.
      const intent = decodeBitcoinPsbt(prepared!.request, prepared!.own);
      expect(intent.warnings).toContainEqual({
        kind: "unconfirmed-signer-output",
        message: expect.any(String),
        level: "danger",
      });
      expect(assessWarnings([intent])).toStrictEqual([
        { code: "bitcoin-unconfirmed-output", level: "danger" },
      ]);

      const seen: Array<Parameters<ChainApis["sign"]>[0]> = [];
      const signing: Pick<ChainApis, "sign"> = {
        sign: async (params) => {
          seen.push(params);
          return signPsbt(params);
        },
      };
      await signDappPsbts(
        signing,
        [prepared!],
        false,
        { kind: "password", password: "pw" },
        () => undefined,
        async () => Promise.resolve("txid"),
      );
      expect(seen[0]?.acknowledgeUnconfirmed).toBe(true);
    },
  );

  it(
    "leaves the acknowledgement off a confirmed template's sign call",
    { timeout: 20_000 },
    async () => {
      const { es, apis } = rig();
      const psbt = dappPsbt(
        [{ script: scriptOf("btc.bip84"), amount: 100_000n }],
        [
          { script: PAYEE_SCRIPT, amount: 80_000n },
          { script: scriptOf("btc.bip84", 1, 0), amount: 15_000n },
        ],
      );
      const [prepared] = await prepareDappPsbts(
        apis,
        es,
        GROUP,
        MAINNET,
        [{ psbt, sign: [signEntry(0, "btc.bip84")] }],
        new Set<string>(),
      );
      expect(prepared!.own.unconfirmed.size).toBe(0);
      const seen: Array<Parameters<ChainApis["sign"]>[0]> = [];
      const signing: Pick<ChainApis, "sign"> = {
        sign: async (params) => {
          seen.push(params);
          return signPsbt(params);
        },
      };
      await signDappPsbts(
        signing,
        [prepared!],
        false,
        { kind: "password", password: "pw" },
        () => undefined,
        async () => Promise.resolve("txid"),
      );
      expect(seen[0]?.acknowledgeUnconfirmed).toBeUndefined();
    },
  );
});
