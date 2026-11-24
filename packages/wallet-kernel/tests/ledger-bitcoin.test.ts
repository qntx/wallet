/**
 * Unit coverage for the Bitcoin protocol client: Merkle tree shapes, wallet-policy serialization,
 * PSBTv2 map splitting, the interactive client-command interpreter (including every hostile
 * deviation), the exported guards, and fuzz invariants — every failure is a LedgerError.
 */

// oxlint-disable vitest/no-conditional-in-test -- hostile tables and the independent oracles branch on case shape
// oxlint-disable eslint/no-await-in-loop -- device answers are asserted one at a time, in transcript order

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createBase58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { p2tr, p2wpkh, Transaction } from "@scure/btc-signer";
import { taprootTweakPubkey } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { Command, Exchange } from "../src/modules/signers/ledger/protocol/apdu.ts";
import {
  interact,
  knownList,
  knownMapping,
  knownWalletPolicy,
  maxRounds,
  newKnown,
} from "../src/modules/signers/ledger/protocol/bitcoin/client.ts";
import {
  btcExtendedPublicKey,
  btcMasterFingerprint,
  btcSignMessage,
  btcSignPsbt,
  btcWalletAddress,
} from "../src/modules/signers/ledger/protocol/bitcoin/index.ts";
import {
  leafHash,
  merkleProof,
  merkleRoot,
} from "../src/modules/signers/ledger/protocol/bitcoin/merkle.ts";
import {
  defaultPolicy,
  policyId,
  serializePolicy,
} from "../src/modules/signers/ledger/protocol/bitcoin/policy.ts";
import type { BitcoinPolicy } from "../src/modules/signers/ledger/protocol/bitcoin/policy.ts";
import {
  mapCommitment,
  psbtV2Maps,
  stripUnhiddenDerivations,
} from "../src/modules/signers/ledger/protocol/bitcoin/psbt.ts";
import type { KeyValue } from "../src/modules/signers/ledger/protocol/bitcoin/psbt.ts";
import { varint } from "../src/modules/signers/ledger/protocol/bytes.ts";
import { LedgerError } from "../src/modules/signers/ledger/protocol/errors.ts";

const H = 0x80_00_00_00;
const ACCT = [H + 84, H, H];
// m/84'/0'/0' for the all-zeros-ish deterministic test seed below
const ROOT = HDKey.fromMasterSeed(hexToBytes("00".repeat(32)));
const XPUB = ROOT.derive(`m/84'/0'/0'`).publicExtendedKey;
// the 4-byte BIP-32 fingerprint as serialized in derivation fields and policy key origins
const FPR = Uint8Array.of(
  ROOT.fingerprint >>> 24,
  (ROOT.fingerprint >>> 16) & 0xff,
  (ROOT.fingerprint >>> 8) & 0xff,
  ROOT.fingerprint & 0xff,
);

const policy = (
  template: BitcoinPolicy["template"] = "wpkh(@0/**)",
  key?: string,
): BitcoinPolicy => ({
  template,
  key: key ?? `[${bytesToHex(FPR)}/84'/0'/0']${XPUB}`,
});

/** Lets a malformed policy reach the API as BitcoinPolicy without a type assertion. */
const isPolicyShape = (value: unknown): value is BitcoinPolicy =>
  typeof value === "object" && value !== null && "template" in value && "key" in value;

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (error) {
    if (error instanceof LedgerError) {
      return error.code;
    }
    throw error;
  }
  return "ok";
};

/** Independent recomputation — iterative bottom-up tree, different from the recursive source. */
const naiveRoot = (leaves: Uint8Array[]): Uint8Array => {
  if (leaves.length === 0) {
    return new Uint8Array(32);
  }
  const level = [...leaves];
  while (level.length > 1) {
    const k = 1 << (31 - Math.clz32(level.length - 1));
    const left = level.slice(0, k);
    const right = level.slice(k);
    level.length = 0;
    level.push(sha256(Uint8Array.of(1, ...naiveRoot(left), ...naiveRoot(right))));
  }
  return level[0] ?? new Uint8Array(0);
};

const h32 = (n: number): Uint8Array => Uint8Array.of(n, ...new Uint8Array(31));

const E000 = "e000";
const OK = "9000";

/** A device that answers the first APDU with `replies` (raw response data ‖ sw), then 9000. */
const device = (
  replies: Array<{ data: Uint8Array; sw: string }>,
): { ex: Exchange; sent: Uint8Array[] } => {
  const sent: Uint8Array[] = [];
  const queue = [...replies];
  const ex: Exchange = async (apdu) => {
    sent.push(apdu);
    const next = queue.shift();
    if (next === undefined) {
      return Promise.resolve(Uint8Array.of(0x90, 0x00));
    }
    return Promise.resolve(Uint8Array.of(...next.data, ...hexToBytes(next.sw)));
  };
  return { ex, sent };
};

const SIGN_CMD: Command = { cla: 0xe1, ins: 0x04, p1: 0, p2: 1, data: new Uint8Array(0) };

const call = async (ex: Exchange, known = newKnown(), rounds = maxRounds(known)) =>
  interact(ex, SIGN_CMD, known, rounds);

describe("ledger bitcoin merkle", () => {
  it("hashes leaves and nodes with distinct domain bytes", () => {
    // leafHash = sha256(0x00 ‖ data); node = sha256(0x01 ‖ l ‖ r) — doc/merkle.md
    expect(bytesToHex(leafHash(h32(9)))).toBe(bytesToHex(sha256(Uint8Array.of(0, ...h32(9)))));
    const [a, b] = [leafHash(h32(1)), leafHash(h32(2))];
    expect(bytesToHex(merkleRoot([a, b]))).toBe(bytesToHex(sha256(Uint8Array.of(1, ...a, ...b))));
  });

  it("matches the reference rules for every size up to 40", () => {
    for (let n = 0; n <= 40; n += 1) {
      const leaves = Array.from({ length: n }, (_, i) => leafHash(h32(i)));
      expect(bytesToHex(merkleRoot(leaves)), `n=${String(n)}`).toBe(bytesToHex(naiveRoot(leaves)));
      for (let i = 0; i < n; i += 1) {
        // independent check: walk the split decomposition top-down; each proof element
        // must be the sibling subtree's root, reported leaf-first by merkleProof
        const expected: string[] = [];
        let lo = 0;
        let hi = n;
        let idx = i;
        while (hi - lo > 1) {
          const k = 1 << (31 - Math.clz32(hi - lo - 1));
          if (idx < k) {
            expected.unshift(bytesToHex(naiveRoot(leaves.slice(lo + k, hi))));
            hi = lo + k;
          } else {
            expected.unshift(bytesToHex(naiveRoot(leaves.slice(lo, lo + k))));
            idx -= k;
            lo += k;
          }
        }
        expect(
          merkleProof(leaves, i).map(bytesToHex),
          `proof n=${String(n)} i=${String(i)}`,
        ).toStrictEqual(expected);
      }
    }
  });

  it("rejects out-of-range proof requests and malformed leaves", () => {
    expect(code(() => merkleProof([], 0))).toBe("invalid-input");
    expect(code(() => merkleRoot([new Uint8Array(4)]))).toBe("invalid-input");
    expect(code(() => merkleProof([leafHash(h32(0))], 1))).toBe("invalid-input");
  });
});

describe("ledger bitcoin policy", () => {
  it("serializes and hashes a default policy per doc/wallet.md", () => {
    const p = policy();
    const ser = serializePolicy(p);
    // 02 ‖ 00 ‖ varint 10 ‖ sha256("wpkh(@0/**)") ‖ 01 ‖ merkleRoot([leafHash(key)])
    expect(ser[0]).toBe(2);
    expect(ser[1]).toBe(0);
    expect(ser[2]).toBe(11);
    expect(bytesToHex(ser.subarray(3, 35))).toBe(
      bytesToHex(sha256(new TextEncoder().encode("wpkh(@0/**)"))),
    );
    expect(ser[35]).toBe(1);
    const root = merkleRoot([leafHash(new TextEncoder().encode(p.key))]);
    expect(bytesToHex(ser.subarray(36))).toBe(bytesToHex(root));
    expect(bytesToHex(policyId(p))).toBe(bytesToHex(sha256(ser)));
  });

  it("builds all four default policies and rejects bad account paths", async () => {
    const cases: Array<[string, string]> = [
      ["btc.bip44", "pkh(@0/**)"],
      ["btc.bip49", "sh(wpkh(@0/**))"],
      ["btc.bip84", "wpkh(@0/**)"],
      ["btc.bip86", "tr(@0/**)"],
    ];
    for (const [chains, desc] of cases) {
      const purpose = desc.startsWith("pkh")
        ? 44
        : desc.startsWith("sh")
          ? 49
          : desc.startsWith("w")
            ? 84
            : 86;
      const acct = [H + purpose, H, H];
      const p = defaultPolicy(
        chains as never,
        FPR,
        acct,
        ROOT.derive(pathStr(acct)).publicExtendedKey,
      );
      expect(p.template).toBe(desc);
      expect(p.key).toContain(`/${String(purpose)}'/0'/0']`);
    }
    expect(code(() => defaultPolicy("btc.bip84", FPR, [H + 44, H, H], XPUB))).toBe("invalid-input");
    expect(code(() => defaultPolicy("btc.bip84", FPR, [H + 84, H + 2, H], XPUB))).toBe(
      "invalid-input",
    );
    expect(code(() => defaultPolicy("btc.bip84", FPR, [H + 84, H, H + 101], XPUB))).toBe(
      "invalid-input",
    );
    expect(code(() => defaultPolicy("btc.bip84", FPR, [H + 84, H], XPUB))).toBe("invalid-input");
    expect(code(() => defaultPolicy("btc.bip84", FPR, [H], XPUB))).toBe("invalid-input");
    expect(code(() => defaultPolicy("btc.bip84", FPR, [], XPUB))).toBe("invalid-input");
    expect(code(() => defaultPolicy("btc.bip84", FPR, [H + 84, H, H, 0], XPUB))).toBe(
      "invalid-input",
    );
    expect(code(() => defaultPolicy("btc.bip84", FPR, [H + 84, H, Number.NaN], XPUB))).toBe(
      "invalid-input",
    );
    expect(code(() => defaultPolicy("btc.bip84", new Uint8Array(3), [H + 84, H, H], XPUB))).toBe(
      "invalid-input",
    );
    expect(code(() => defaultPolicy("btc.bip84", FPR, [H + 84, H, H], "xpub_wrong"))).toBe(
      "invalid-input",
    );
    expect(
      code(() =>
        defaultPolicy("btc.bip84", FPR, [H + 84, H, H], ROOT.derive("m/84'/0'").publicExtendedKey),
      ),
    ).toBe("invalid-input");
    expect(code(() => defaultPolicy("btc.bip50" as never, FPR, [H + 84, H, H], XPUB))).toBe(
      "invalid-input",
    );
    // an origin step above the hardened range is invalid-input through policyKey too
    const { ex } = device([{ data: new TextEncoder().encode("bc1q0"), sw: "9000" }]);
    await expect(
      btcWalletAddress(
        ex,
        policy("wpkh(@0/**)", `[${bytesToHex(FPR)}/2147483648'/0'/0']${XPUB}`),
        0,
        0,
        false,
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("ledger bitcoin psbt maps", () => {
  const PSBT = ((): Uint8Array => {
    const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
    tx.addInput({ txid: "11".repeat(32), index: 0, sequence: 0xff_ff_ff_fd });
    tx.addOutputAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 1000n);
    return tx.toPSBT(2);
  })();

  it("splits a v2 PSBT into sorted maps with matching counts", () => {
    const maps = psbtV2Maps(PSBT);
    expect(maps.inputs).toHaveLength(1);
    expect(maps.outputs).toHaveLength(1);
    const globalTypes = maps.global.map((kv) => kv.key[0]);
    expect(globalTypes).toContain(4);
    expect(globalTypes).toContain(5);
    expect(maps.inputs[0]?.length ?? 0).toBeGreaterThan(0);
    const commit = mapCommitment(maps.global);
    expect(commit).toHaveLength(65 + (varint(maps.global.length).length - 1));
  });

  it("rejects non-PSBT bytes and truncated streams", () => {
    expect(code(() => psbtV2Maps(new Uint8Array(0)))).toBe("invalid-input");
    expect(code(() => psbtV2Maps(Uint8Array.of(0x70, 0x73)))).toBe("invalid-input");
    expect(code(() => psbtV2Maps(PSBT.subarray(0, -3)))).toBe("invalid-input");
  });
  // raw BIP-370 streams: already-v2 input is split without normalization
  const rec = (key: ReadonlyArray<number>, value: ReadonlyArray<number>): number[] => [
    key.length,
    ...key,
    value.length,
    ...value,
  ];
  const MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];
  const GLOBAL_RECS = [rec([0xfb], [2, 0, 0, 0]), rec([0x04], [1]), rec([0x05], [0])];
  const GLOBAL = GLOBAL_RECS.flat();
  const stream = (global: number[][], maps: number[][][]): Uint8Array =>
    Uint8Array.from([...MAGIC, ...global.flat(), 0, ...maps.flatMap((map) => [...map.flat(), 0])]);

  it("normalizes a v0 PSBT to v2 maps and preserves unknown pairs on v2", () => {
    const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
    tx.addInput({ txid: "11".repeat(32), index: 0 });
    tx.addOutputAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 1000n);
    const fromV0 = psbtV2Maps(tx.toPSBT(0));
    expect(fromV0.inputs).toHaveLength(1);
    // an unknown global key survives verbatim on an already-v2 stream
    const unknown = stream([...GLOBAL_RECS, rec([0x99], [1])], [[rec([1], [2])]]);
    const maps = psbtV2Maps(unknown);
    expect(maps.global.some((kv) => kv.key[0] === 0x99)).toBe(true);
  });

  it("rejects malformed v2 streams", () => {
    const cases: Uint8Array[] = [
      Uint8Array.from(MAGIC), // no global map at all
      Uint8Array.from([...MAGIC, ...GLOBAL]), // unterminated last map
      // global without the input-count key
      stream([rec([0xfb], [2, 0, 0, 0]), rec([0x05], [0])], []),
      // the input count is not a complete varint
      stream([rec([0xfb], [2, 0, 0, 0]), rec([0x04], [0xfd, 0x01]), rec([0x05], [0])], []),
      // declares one input but the stream has none
      stream(GLOBAL_RECS, []),
      // duplicate key inside an input map
      stream(GLOBAL_RECS, [[rec([1], [2]), rec([1], [3])]]),
      // duplicate key inside the global map
      stream([...GLOBAL_RECS, ...GLOBAL_RECS], [[rec([1], [2])]]),
    ];
    for (const bad of cases) {
      expect(code(() => psbtV2Maps(bad))).toBe("invalid-input");
    }
  });
});

describe("ledger bitcoin output derivation stripping", () => {
  const pubOf = (path: string): Uint8Array => {
    const pub = ROOT.derive(path).publicKey;
    if (!(pub instanceof Uint8Array)) {
      throw new TypeError("derive failed");
    }
    return pub;
  };
  const CHANGE_PUB = pubOf("m/84'/0'/0'/1/0");
  const FAR_PUB = pubOf("m/84'/0'/0'/1/5000");
  const TAP_PUB = pubOf("m/86'/0'/0'/1/5000").subarray(1);
  const FOREIGN_PUB = pubOf("m/84'/0'/0'/0/9");
  const fp = ROOT.fingerprint;
  /* Outputs: a discoverable change the kernel hides, a far change and a taproot derivation it
     shows, and a foreign-fingerprint pair that is not ours to strip. */
  const PSBT = ((): Uint8Array => {
    const tx = new Transaction({
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    tx.addInput({ txid: "11".repeat(32), index: 0 });
    tx.addOutput({
      script: p2wpkh(CHANGE_PUB).script,
      amount: 4_000n,
      bip32Derivation: [[CHANGE_PUB, { fingerprint: fp, path: [H + 84, H, H, 1, 0] }]],
    });
    tx.addOutput({
      script: p2wpkh(FAR_PUB).script,
      amount: 3_000n,
      bip32Derivation: [[FAR_PUB, { fingerprint: fp, path: [H + 84, H, H, 1, 5000] }]],
    });
    tx.addOutput({
      script: p2tr(TAP_PUB).script,
      amount: 2_000n,
      tapBip32Derivation: [
        [TAP_PUB, { hashes: [], der: { fingerprint: fp, path: [H + 86, H, H, 1, 5000] } }],
      ],
    });
    tx.addOutput({
      script: p2wpkh(FOREIGN_PUB).script,
      amount: 1_000n,
      bip32Derivation: [[FOREIGN_PUB, { fingerprint: 0xde_ad_be_ef, path: [H + 84, H, H, 0, 9] }]],
    });
    return tx.toPSBT(2);
  })();
  const HIDDEN = new Set([bytesToHex(p2wpkh(CHANGE_PUB).script)]);
  const typesOf = (kvs: ReadonlyArray<KeyValue> | undefined): number[] =>
    (kvs ?? []).map((kv) => kv.key[0] ?? -1);

  it("strips the wallet's pairs from shown outputs and keeps them on hidden change", () => {
    const maps = psbtV2Maps(stripUnhiddenDerivations(PSBT, HIDDEN, FPR));
    expect(typesOf(maps.outputs[0])).toContain(0x02); // hidden change keeps its derivation
    expect(typesOf(maps.outputs[1])).not.toContain(0x02); // far change: shown by address
    expect(typesOf(maps.outputs[2])).not.toContain(0x07); // taproot derivation: stripped too
    expect(typesOf(maps.outputs[3])).toContain(0x02); // foreign fingerprint stays
    // the output scripts themselves are untouched
    for (const kvs of maps.outputs) {
      expect(kvs.some((kv) => kv.key[0] === 0x04)).toBe(true);
    }
  });

  it("is a byte-identical no-op when every own pair sits on hidden change", () => {
    const allHidden = new Set([
      bytesToHex(p2wpkh(CHANGE_PUB).script),
      bytesToHex(p2wpkh(FAR_PUB).script),
      bytesToHex(p2tr(TAP_PUB).script),
    ]);
    expect(stripUnhiddenDerivations(PSBT, allHidden, FPR)).toBe(PSBT);
    const shown = psbtV2Maps(stripUnhiddenDerivations(PSBT, HIDDEN, FPR));
    expect(shown.outputs).toHaveLength(4);
  });
});

describe("ledger bitcoin client commands", () => {
  it("answers YIELD, GET_PREIMAGE, leaf index/proof, and GET_MORE_ELEMENTS", async () => {
    const known = newKnown();
    const list = [h32(1), h32(2), h32(3), h32(4), h32(5)];
    knownList(known, list);
    const root = merkleRoot(list.map(leafHash));
    const leaves = list.map(leafHash);
    const cmds = [
      // YIELD blob
      Uint8Array.of(0x10, 0xde, 0xad),
      // leaf index
      Uint8Array.from([0x42, ...root, ...(leaves[2] ?? [])]),
      // leaf proof
      Uint8Array.of(0x41, ...root, ...varint(5), ...varint(2)),
    ];
    const { ex, sent } = device(cmds.map((data) => ({ data, sw: E000 })));
    const out = await call(ex, known);
    expect(out.yielded).toHaveLength(1);
    expect(bytesToHex(out.yielded[0] ?? new Uint8Array())).toBe("dead");
    // the leaf-index answer: found=1 ‖ varint index 2
    expect([...(sent[2]?.subarray(5) ?? [])]).toStrictEqual([1, 2]);
  });

  it("serves a large preimage across GET_MORE_ELEMENTS", async () => {
    const known = newKnown();
    const blob = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    knownList(known, [blob]);
    const { ex, sent } = device([
      { data: Uint8Array.of(0x40, 0, ...sha256(Uint8Array.of(0, ...blob))), sw: E000 },
      { data: Uint8Array.of(0xa0), sw: E000 },
    ]);
    await call(ex, known);
    // second CONTINUE answers GET_MORE_ELEMENTS with single-byte elements
    const answer = sent[2]?.subarray(5) ?? new Uint8Array();
    // 301-byte preimage: 253 max first payload → 50 one-byte elements queued → "50 ‖ 1 ‖ ..."
    expect(answer[0]).toBe(50);
    expect(answer[1]).toBe(1);
    expect(sent).toHaveLength(3);
  });

  it("serves a deep proof tail through GET_MORE_ELEMENTS", async () => {
    const known = newKnown();
    const list = Array.from({ length: 200 }, (_, i) => h32(i));
    knownList(known, list);
    const root = merkleRoot(list.map(leafHash));
    const { ex, sent } = device([
      { data: Uint8Array.of(0x41, ...root, ...varint(200), ...varint(0)), sw: E000 },
      { data: Uint8Array.of(0xa0), sw: E000 },
    ]);
    await call(ex, known);
    // proof depth 8 > the 6 hashes a 255-byte reply holds; the last 2 continue as elements
    const answer = sent[2]?.subarray(5) ?? new Uint8Array();
    expect(answer[0]).toBe(2);
    expect(answer[1]).toBe(32);
  });

  it("rejects unknown commands and unknown roots/hashes", async () => {
    for (const data of [
      Uint8Array.of(0x99),
      Uint8Array.of(0x40, 0, ...new Uint8Array(32)),
      Uint8Array.of(0x42, ...new Uint8Array(32), ...new Uint8Array(32)),
      Uint8Array.of(0x41, ...new Uint8Array(32), 1, 0),
      Uint8Array.of(0xa0),
      Uint8Array.of(0x10), // YIELD with no payload
      Uint8Array.of(0x40, 1, ...new Uint8Array(32)), // bad version
      Uint8Array.of(0xa0, 0x00), // trailing byte
    ]) {
      const { ex } = device([{ data, sw: E000 }]);
      await expect(call(ex)).rejects.toMatchObject({ code: "invalid-response" });
    }
    // trailing bytes on GET_PREIMAGE must fail even for a hash the client knows
    const known = newKnown();
    knownList(known, [h32(1)]);
    const { ex } = device([
      { data: Uint8Array.of(0x40, 0, ...sha256(Uint8Array.of(0, ...h32(1))), 0x00), sw: E000 },
    ]);
    await expect(call(ex, known)).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects leaf-proof misuse: wrong size, out-of-range index, pending queue", async () => {
    const known = newKnown();
    const list = [h32(1), h32(2)];
    knownList(known, list);
    const root = merkleRoot(list.map(leafHash));
    const leaves = list.map(leafHash);
    for (const data of [
      Uint8Array.of(0x41, ...root, ...varint(9), ...varint(0)),
      Uint8Array.of(0x41, ...root, ...varint(2), ...varint(2)),
      Uint8Array.of(0x41, ...root, ...varint(2), ...varint(0), 0x00),
    ]) {
      const { ex } = device([{ data, sw: E000 }]);
      await expect(call(ex, known)).rejects.toMatchObject({ code: "invalid-response" });
    }
    // trailing bytes on a leaf-index request must fail even for a known root
    const { ex: exT } = device([
      { data: Uint8Array.of(0x42, ...root, ...(leaves[0] ?? []), 0x00), sw: E000 },
    ]);
    await expect(call(exT, known)).rejects.toMatchObject({ code: "invalid-response" });
    // pending queue: a preimage just over one APDU queues a few elements, then a proof or index
    // request arrives (the queue must be non-empty but small so threshold mutants are caught)
    const big = Uint8Array.from({ length: 253 }, (_, i) => i & 0xff);
    knownList(known, [big]);
    for (const queued of [
      Uint8Array.of(0x41, ...root, ...varint(2), ...varint(0)),
      Uint8Array.of(0x42, ...root, ...(leaves[0] ?? [])),
    ]) {
      const { ex } = device([
        { data: Uint8Array.of(0x40, 0, ...sha256(Uint8Array.of(0, ...big))), sw: E000 },
        { data: queued, sw: E000 },
      ]);
      await expect(call(ex, known)).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("answers a leaf index of 0 when the leaf is not in the tree", async () => {
    const known = newKnown();
    const list = [h32(1), h32(2)];
    knownList(known, list);
    const root = merkleRoot(list.map(leafHash));
    const { ex } = device([
      { data: Uint8Array.of(0x42, ...root, ...new Uint8Array(32)), sw: E000 },
    ]);
    // found=0 is a normal answer, not a fault
    await expect(call(ex, known)).resolves.toBeDefined();
  });

  it("enforces the round bound", async () => {
    const { ex } = device(
      Array.from({ length: 10 }, () => ({ data: Uint8Array.of(0x10, 0xaa), sw: E000 })),
    );
    await expect(call(ex, newKnown(), 3)).rejects.toMatchObject({ code: "invalid-response" });
    await expect(call(ex, newKnown(), -1)).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("maps a non-interrupt status through the allow-list", async () => {
    const { ex } = device([{ data: new Uint8Array(0), sw: "6985" }]);
    await expect(call(ex)).rejects.toMatchObject({ code: "user-rejected" });
  });
});

describe("ledger bitcoin api guards", () => {
  it("rejects a non-ASCII reply and an unknown policy template", async () => {
    const { ex } = device([{ data: Uint8Array.of(0x80, 0x81), sw: OK }]);
    await expect(btcExtendedPublicKey(ex, ACCT, false)).rejects.toMatchObject({
      code: "invalid-response",
    });
    const { ex: ex2 } = device([{ data: new TextEncoder().encode("bc1q0"), sw: OK }]);
    const bogus: unknown = { ...policy(), template: "bogus" };
    if (!isPolicyShape(bogus)) {
      throw new Error("test bug: bogus policy did not shape-check");
    }
    await expect(btcWalletAddress(ex2, bogus, 0, 0, false)).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("rejects a policy xpub that cannot derive", async () => {
    // a structurally valid xpub whose key bytes are off-curve: parses at depth 3, derive fails
    const raw = Uint8Array.from([
      ...hexToBytes("0488b21e"),
      3,
      ...new Uint8Array(4),
      ...new Uint8Array(4),
      ...new Uint8Array(32),
      2,
      ...new Uint8Array(32),
    ]);
    const fake = policy(
      "wpkh(@0/**)",
      `[${bytesToHex(FPR)}/84'/0'/0']${createBase58check(sha256).encode(raw)}`,
    );
    const { ex } = device([{ data: new TextEncoder().encode("bc1q0"), sw: OK }]);
    await expect(btcWalletAddress(ex, fake, 0, 0, false)).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("rejects a wrong-length fingerprint reply", async () => {
    const { ex } = device([{ data: Uint8Array.of(1, 2, 3), sw: OK }]);
    await expect(btcMasterFingerprint(ex)).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects an xpub whose depth or index does not match the request", async () => {
    // reply: a valid mainnet xpub at a different depth (m/84'/0')
    const wrong = new TextEncoder().encode(ROOT.derive("m/84'/0'").publicExtendedKey);
    const { ex } = device([{ data: wrong, sw: OK }]);
    await expect(btcExtendedPublicKey(ex, ACCT, false)).rejects.toMatchObject({
      code: "invalid-response",
    });
    // same depth, different child index
    const wrongIndex = new TextEncoder().encode(ROOT.derive("m/84'/0'/1'").publicExtendedKey);
    const { ex: exI } = device([{ data: wrongIndex, sw: OK }]);
    await expect(btcExtendedPublicKey(exI, ACCT, false)).rejects.toMatchObject({
      code: "invalid-response",
    });
    const notXpub = new TextEncoder().encode("not-an-xpub");
    const { ex: ex2 } = device([{ data: notXpub, sw: OK }]);
    await expect(btcExtendedPublicKey(ex2, ACCT, false)).rejects.toMatchObject({
      code: "invalid-response",
    });
    await expect(btcExtendedPublicKey(ex, [], false)).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("rejects an address reply that does not match the policy key", async () => {
    const { ex } = device([
      { data: new TextEncoder().encode("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), sw: OK },
    ]);
    await expect(btcWalletAddress(ex, policy(), 0, 0, false)).rejects.toMatchObject({
      code: "invalid-response",
    });
    await expect(btcWalletAddress(ex, policy(), 2 as never, 0, false)).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(btcWalletAddress(ex, policy(), 0, 50_001, false)).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(
      btcWalletAddress(ex, policy("wpkh(@0/**)", "[xyz]bad"), 0, 0, false),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(
      btcWalletAddress(
        ex,
        policy("wpkh(@0/**)", `[73c5da0a/84'/0'/0']${ROOT.derive("m/84'/0'").publicExtendedKey}`),
        0,
        0,
        false,
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("ledger bitcoin yield guards", () => {
  // DER over an arbitrary digest — shape is all the parser checks
  const DER = secp256k1.Signature.fromBytes(secp256k1.sign(sha256(h32(7)), h32(9))).toBytes("der");
  const CHILD = ROOT.derive("m/84'/0'/0'/0/0");
  const CHILD_PUB = ((): Uint8Array => {
    const pub = CHILD.publicKey;
    if (!(pub instanceof Uint8Array)) {
      throw new TypeError("derive failed");
    }
    return pub;
  })();
  const ecdsa = (index: number, pub: Uint8Array): Uint8Array =>
    Uint8Array.of(...varint(index), pub.length, ...pub, ...DER, 0x01);
  const yieldDevice = (items: Uint8Array[]): Exchange => {
    const { ex } = device(items.map((data) => ({ data: Uint8Array.of(0x10, ...data), sw: E000 })));
    return ex;
  };
  // a PSBT whose input claims CHILD under this policy — the ownership check can pass on it
  const OWNED_PSBT = ((): Uint8Array => {
    const tx = new Transaction({
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    tx.addInput({
      txid: "11".repeat(32),
      index: 0,
      witnessUtxo: { script: p2wpkh(CHILD_PUB).script, amount: 1000n },
      bip32Derivation: [[CHILD_PUB, { fingerprint: ROOT.fingerprint, path: [H + 84, H, H, 0, 0] }]],
    });
    tx.addOutputAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 900n);
    return tx.toPSBT(2);
  })();

  it("accepts a well-formed ECDSA yield for an owned input", async () => {
    const out = await btcSignPsbt(yieldDevice([ecdsa(0, CHILD_PUB)]), OWNED_PSBT, policy());
    expect(out).toHaveLength(1);
    expect(out[0]?.input).toBe(0);
  });

  it("rejects out-of-range inputs, tags, pubkey lengths, tapscript, and bad signatures", async () => {
    const pub = new Uint8Array(33);
    pub[0] = 2;
    const items: Uint8Array[] = [
      ecdsa(3, CHILD_PUB), // input index out of range
      Uint8Array.of(...varint(0x1_00_00), 33, ...pub, ...DER, 0x01), // MuSig2 tag
      Uint8Array.of(0, 5, ...new Uint8Array(5), ...DER, 0x01), // pubkey length
      Uint8Array.of(0, 64, ...new Uint8Array(64), ...DER, 0x01), // tapscript augm
      Uint8Array.of(0, 33, ...CHILD_PUB, ...h32(3)), // not DER
      Uint8Array.of(0, 32, ...new Uint8Array(32), ...new Uint8Array(10)), // taproot sig length
    ];
    for (const item of items) {
      await expect(btcSignPsbt(yieldDevice([item]), OWNED_PSBT, policy())).rejects.toMatchObject({
        code: "invalid-response",
      });
    }
  });
  // raw BIP-370 stream builder for hostile input maps psbtV2Maps passes through on v2
  const prec = (key: ReadonlyArray<number>, value: ReadonlyArray<number>): number[] => [
    key.length,
    ...key,
    value.length,
    ...value,
  ];
  const u32le = (n: number): number[] => [
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ];
  const ZERO4 = new Uint8Array(4);
  const WPKH_PATH = [H + 84, H, H, 0, 0];
  const derValue = (fpr: Uint8Array, path: ReadonlyArray<number>): number[] => [
    ...fpr,
    ...path.flatMap(u32le),
  ];
  const signStream = (inputMap: number[][]): Uint8Array =>
    Uint8Array.from([
      0x70,
      0x73,
      0x62,
      0x74,
      0xff,
      ...prec([0xfb], [2, 0, 0, 0]),
      ...prec([0x04], [1]),
      ...prec([0x05], [0]),
      0,
      ...inputMap.flat(),
      0,
    ]);
  const ecdsaEntry = (pub: Uint8Array, value: ReadonlyArray<number>): number[] =>
    prec([0x06, ...pub], value);

  it("rejects derivation entries that do not prove the yield", async () => {
    const cases: Uint8Array[] = [
      // right pubkey, wrong fingerprint
      signStream([ecdsaEntry(CHILD_PUB, derValue(ZERO4, WPKH_PATH))]),
      // right fingerprint, path outside the policy account
      signStream([ecdsaEntry(CHILD_PUB, derValue(FPR, [H + 44, H, H, 0, 0]))]),
      // truncated derivation value
      signStream([ecdsaEntry(CHILD_PUB, [1])]),
      // a change step outside 0/1
      signStream([ecdsaEntry(CHILD_PUB, derValue(FPR, [H + 84, H, H, 2, 0]))]),
      // a hardened index step — never a wallet child
      signStream([ecdsaEntry(CHILD_PUB, derValue(FPR, [H + 84, H, H, 0, H]))]),
    ];
    for (const psbt of cases) {
      await expect(
        btcSignPsbt(yieldDevice([ecdsa(0, CHILD_PUB)]), psbt, policy()),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("accepts a taproot yield only for the tweaked policy child", async () => {
    const X86 = ROOT.derive("m/86'/0'/0'");
    const xpub86 = X86.publicExtendedKey;
    const child = X86.deriveChild(0).deriveChild(0);
    const xonly = ((): Uint8Array => {
      const pub = child.publicKey;
      if (!(pub instanceof Uint8Array)) {
        throw new TypeError("derive failed");
      }
      return pub.subarray(1);
    })();
    const trPolicy = policy("tr(@0/**)", `[${bytesToHex(FPR)}/86'/0'/0']${xpub86}`);
    const trPath = [H + 86, H, H, 0, 0];
    const tapValue = [0x00, ...derValue(FPR, trPath)]; // 0 tapleaf hashes
    const [tweaked] = taprootTweakPubkey(xonly, new Uint8Array());
    const trYield = Uint8Array.of(0, 32, ...tweaked, ...new Uint8Array(64));
    const good = signStream([prec([0x16, ...xonly], tapValue)]);
    const out = await btcSignPsbt(yieldDevice([trYield]), good, trPolicy);
    expect(out).toHaveLength(1);
    // a claimed key that is not the child at the derivation path
    const wrong = signStream([prec([0x16, ...new Uint8Array(32)], tapValue)]);
    await expect(btcSignPsbt(yieldDevice([trYield]), wrong, trPolicy)).rejects.toMatchObject({
      code: "invalid-response",
    });
    // a malformed taproot derivation value
    const broken = signStream([prec([0x16, ...xonly], [1])]);
    await expect(btcSignPsbt(yieldDevice([trYield]), broken, trPolicy)).rejects.toMatchObject({
      code: "invalid-response",
    });
    // the derivation proves the internal key, but the yield is not its tweak — the untweaked
    // internal key itself must be refused
    const untweaked = Uint8Array.of(0, 32, ...xonly, ...new Uint8Array(64));
    await expect(btcSignPsbt(yieldDevice([untweaked]), good, trPolicy)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("rejects a duplicate (input, pubkey) yield", async () => {
    await expect(
      btcSignPsbt(yieldDevice([ecdsa(0, CHILD_PUB), ecdsa(0, CHILD_PUB)]), OWNED_PSBT, policy()),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects a yielded key the policy does not own", async () => {
    const other = ROOT.derive("m/84'/0'/0'/0/9").publicKey;
    if (!(other instanceof Uint8Array)) {
      throw new TypeError("derive failed");
    }
    await expect(
      btcSignPsbt(yieldDevice([ecdsa(0, other)]), OWNED_PSBT, policy()),
    ).rejects.toMatchObject({ code: "invalid-response" });
    // and any key at all when the input carries no derivation for the policy fingerprint
    const tx = new Transaction({
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    tx.addInput({
      txid: "11".repeat(32),
      index: 0,
      witnessUtxo: { script: p2wpkh(CHILD_PUB).script, amount: 1000n },
    });
    tx.addOutputAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 900n);
    await expect(
      btcSignPsbt(yieldDevice([ecdsa(0, CHILD_PUB)]), tx.toPSBT(2), policy()),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("ledger bitcoin message guards", () => {
  it("rejects a non-65-byte reply and a header outside the pinned range", async () => {
    const { ex } = device([{ data: new Uint8Array(64), sw: OK }]);
    await expect(btcSignMessage(ex, ACCT, h32(1))).rejects.toMatchObject({
      code: "invalid-response",
    });
    // a short reply with an otherwise valid header must still fail the 65-byte check
    const { ex: exS } = device([{ data: Uint8Array.of(0x1f, ...new Uint8Array(63)), sw: OK }]);
    await expect(btcSignMessage(exS, ACCT, h32(1))).rejects.toMatchObject({
      code: "invalid-response",
    });
    const { ex: ex2 } = device([{ data: Uint8Array.of(0x1b, ...new Uint8Array(64)), sw: OK }]);
    await expect(btcSignMessage(ex2, ACCT, h32(1))).rejects.toMatchObject({
      code: "invalid-response",
    });
    const { ex: ex3 } = device([{ data: Uint8Array.of(0x1f, ...new Uint8Array(64)), sw: OK }]);
    const out = await btcSignMessage(ex3, ACCT, h32(1));
    expect(out.header).toBe(31);
  });
});

describe("ledger bitcoin fuzz", () => {
  it("client-command interpreter and psbtV2Maps fail closed on random bytes", async () => {
    let state = 0x12_34_56_78;
    const rand = (n: number): Uint8Array =>
      Uint8Array.from({ length: n }, () => {
        state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
        return (state >> 8) & 0xff;
      });
    for (let i = 0; i < 300; i += 1) {
      const data = rand(i % 80);
      expect(code(() => psbtV2Maps(data))).toMatch(/invalid-input|ok/);
      const { ex } = device([{ data, sw: E000 }]);
      // the interpreter must never throw a non-LedgerError
      await call(ex)
        .then(() => "ok")
        .catch((error: unknown) => {
          if (!(error instanceof LedgerError)) {
            throw error;
          }
          return error.code;
        });
    }
  });
});

/** Reference-style known-map registration used by SIGN_PSBT setup (kept exported via client). */
const smokeKnownMapping = (): void => {
  expect.hasAssertions();
  const known = newKnown();
  const kvs: KeyValue[] = [
    { key: Uint8Array.of(1), value: Uint8Array.of(2) },
    { key: Uint8Array.of(3), value: Uint8Array.of(4) },
  ];
  knownMapping(known, kvs);
  knownWalletPolicy(known, policy());
  expect(known.preimages.size).toBeGreaterThan(0);
  expect(known.trees.size).toBeGreaterThan(0);
  expect(maxRounds(known)).toBeGreaterThan(8);
};

// oxlint-disable-next-line vitest/expect-expect -- assertions live in smokeKnownMapping
it("registers wallet-policy and map preimages", smokeKnownMapping);

const pathStr = (path: ReadonlyArray<number>): string =>
  `m/${path.map((s) => (s >= H ? `${String(s - H)}'` : String(s))).join("/")}`;
