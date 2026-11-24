// oxlint-disable vitest/no-conditional-in-test -- plan/recorded fixtures narrow via guard throws
import { hexToBytes } from "@noble/hashes/utils.js";
import { Transaction as ScureTransaction } from "@scure/btc-signer/transaction.js";
import * as fc from "fast-check";
/**
 * Layer-5 Bitcoin coverage: offline replay of the live emulator recordings with independent
 * signature verification (sighashes recomputed with bitcoinjs-lib + tiny-secp256k1, ECDSA and
 * BIP-340 verified with noble — no kernel signing code), bitcoinPrepare refusal cases, hostile
 * scripted TxRequest exchanges for every malformed device answer, and fast-check fuzzes over the
 * TxRequest payload decoder.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  bitcoinDisplay,
  bitcoinPrepare,
  signBitcoinMessage,
  signBitcoinTransaction,
} from "../src/modules/signers/onekey/protocol/bitcoin.ts";
import type { BitcoinSignEntry } from "../src/modules/signers/onekey/protocol/bitcoin.ts";
import type { DeviceInfo } from "../src/modules/signers/onekey/protocol/device.ts";
import { OneKeyError } from "../src/modules/signers/onekey/protocol/errors.ts";
import { encodeMessage } from "../src/modules/signers/onekey/protocol/frame.ts";
import {
  BtcMessageSignature,
  BtcTxRequest,
} from "../src/modules/signers/onekey/protocol/messages.ts";
import { encode } from "../src/modules/signers/onekey/protocol/proto.ts";
import type { Decoded, MessageDef } from "../src/modules/signers/onekey/protocol/proto.ts";
import type { Exchange } from "../src/modules/signers/onekey/protocol/session.ts";
import { loadVectors } from "./helpers.ts";
import {
  buildChangePsbt,
  buildMixedPsbt,
  scriptTypeFor,
} from "./onekey-emulator/bitcoin-fixtures.ts";
import {
  ecdsaOk,
  schnorrOk,
  sighash,
  sighashTweakedKey,
} from "./onekey-emulator/bitcoin-verify.ts";
import { replayExchange, loadTranscript, transcriptSession } from "./onekey-emulator/index.ts";
import type { Transcript } from "./onekey-emulator/index.ts";

const H = 0x80_00_00_00;
const hex = hexToBytes;

const transcripts: Record<"classic1s" | "pro", Transcript> = {
  classic1s: loadTranscript("classic1s"),
  pro: loadTranscript("pro"),
};

type PlanTask = { path: number[]; publicKey: string; digest?: string; message?: string };
type PlanCase = {
  name: string;
  key: { path: number[]; publicKey: string };
  request: {
    psbt?: string;
    message?: string;
    format?: string;
    inputs?: Array<{ index: number; path: number[]; publicKey: string }>;
  };
  stages: PlanTask[][];
};
const plans = (loadVectors("chains/signing-plans.json") as { cases: PlanCase[] }).cases;
const planCase = (name: string): PlanCase => {
  const found = plans.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`signing plan ${name} missing`);
  }
  return found;
};
const everyTemplatePsbt = (): Uint8Array => {
  const { psbt } = planCase("bitcoin-psbt-every-template").request;
  if (psbt === undefined) {
    throw new Error("plan carries no psbt");
  }
  return hex(psbt);
};
const signPlan = (name: string): BitcoinSignEntry[] => {
  const [stage] = planCase(name).stages;
  if (stage === undefined) {
    throw new Error(`plan case ${name} has no stages`);
  }
  return stage.map((task, index) => ({
    index,
    path: task.path,
    scriptType: scriptTypeFor(task.path),
  }));
};

const CLASSIC_INFO: DeviceInfo = {
  model: "classic1s",
  firmware: [3, 21, 0],
  deviceId: "0D8A8E040824F2BDC7F7DDE0",
  capabilities: [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000],
  bitcoinOnly: false,
  pinProtection: false,
  passphraseProtection: false,
  unlocked: true,
  sessionId: undefined,
};
const PRO_INFO: DeviceInfo = { ...CLASSIC_INFO, model: "pro", firmware: [4, 21, 0] };
const INFO_FOR = { classic1s: CLASSIC_INFO, pro: PRO_INFO } as const;

async function thrown(fn: () => unknown): Promise<OneKeyError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof OneKeyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw");
}

function scripted(responses: Uint8Array[]): { exchange: Exchange; writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  const exchange = async (data: Uint8Array): Promise<Uint8Array> => {
    writes.push(new Uint8Array(data));
    const next = responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error("scripted device ran out of responses"));
    }
    return Promise.resolve(next);
  };
  return { exchange, writes };
}

const noExchange = (): Exchange => async () => Promise.reject(new Error("no exchange expected"));

const reply = <D extends MessageDef>(def: D, value: Decoded<D["fields"]>): Uint8Array =>
  encodeMessage(def.typeId, encode(def, value));

const txRequest = (value: Decoded<typeof BtcTxRequest.fields>): Uint8Array =>
  reply(BtcTxRequest, value);

const derSig = (r: bigint, s: bigint): Uint8Array => {
  const int = (v: bigint): Uint8Array => {
    let b = hex(v.toString(16).padStart(64, "0"));
    while (b.length > 1 && b[0] === 0 && ((b[1] ?? 0) & 0x80) === 0) {
      b = b.slice(1);
    }
    return ((b[0] ?? 0) & 0x80) === 0 ? b : Uint8Array.of(0, ...b);
  };
  const rb = int(r);
  const sb = int(s);
  const body = Uint8Array.of(0x02, rb.length, ...rb, 0x02, sb.length, ...sb);
  return Uint8Array.of(0x30, body.length, ...body);
};

const SPENDTAPROOT = 5;

/** The mixed-template PSBT with the synthesized taproot prev tx, exactly as the recorder built it. */
const psbtVarint = (psbt: Uint8Array, offset: number): [number, number] => {
  const first = psbt[offset];
  if (first === undefined) {
    throw new Error("psbt truncated");
  }
  if (first < 0xfd) {
    return [first, offset + 1];
  }
  if (first === 0xfd) {
    return [(psbt[offset + 1] ?? 0) | ((psbt[offset + 2] ?? 0) << 8), offset + 3];
  }
  if (first === 0xfe) {
    return [
      (psbt[offset + 1] ?? 0) |
        ((psbt[offset + 2] ?? 0) << 8) |
        ((psbt[offset + 3] ?? 0) << 16) |
        ((psbt[offset + 4] ?? 0) << 24),
      offset + 5,
    ];
  }
  throw new Error("64-bit varints not supported");
};

/** Offset of input 0's key-value map inside a PSBTv0 blob (right after the global map). */
const psbtInputMapOffset = (psbt: Uint8Array): number => {
  let offset = 5; // magic
  for (;;) {
    const [keyLength, after] = psbtVarint(psbt, offset);
    if (keyLength === 0) {
      return after;
    }
    const [valueLength, valueStart] = psbtVarint(psbt, after + keyLength);
    offset = valueStart + valueLength;
  }
};

/** Splice a PSBT_IN_WITNESS_UTXO record into input 0 of a PSBTv0 blob. */
const injectWitnessUtxo = (psbt: Uint8Array, value: Uint8Array): Uint8Array => {
  const offset = psbtInputMapOffset(psbt);
  const record = Uint8Array.of(0x01, 0x01, value.length, ...value);
  return Uint8Array.of(...psbt.slice(0, offset), ...record, ...psbt.slice(offset));
};

/** Flip the last byte of input 0's PSBT_IN_NON_WITNESS_UTXO value, breaking its txid. */
const corruptPrevTx = (psbt: Uint8Array): Uint8Array => {
  let offset = psbtInputMapOffset(psbt);
  for (;;) {
    const [keyLength, after] = psbtVarint(psbt, offset);
    if (keyLength === 0) {
      throw new Error("input map carries no non_witness_utxo");
    }
    const [valueLength, valueStart] = psbtVarint(psbt, after + keyLength);
    offset = valueStart + valueLength;
    if (psbt[after] === 0x00 && keyLength === 1) {
      const out = new Uint8Array(psbt);
      const last = offset - 1;
      out[last] = (out[last] ?? 0) ^ 0xff;
      return out;
    }
  }
};

/** One-input PSBT spending the every-template vector's first prevout with custom outputs. */
const psbtWithOutputs = (outputs: Array<{ script: Uint8Array; amount: bigint }>): Uint8Array => {
  const src = ScureTransaction.fromPSBT(everyTemplatePsbt(), { allowUnknownInputs: true });
  const input = src.getInput(0);
  if (input.txid === undefined || input.index === undefined || input.nonWitnessUtxo === undefined) {
    throw new Error("source PSBT input is incomplete");
  }
  const tx = new ScureTransaction({ version: 2, lockTime: 0, allowUnknownOutputs: true });
  tx.addInput({
    txid: input.txid,
    index: input.index,
    sequence: input.sequence ?? 0xff_ff_ff_ff,
    nonWitnessUtxo: input.nonWitnessUtxo,
  });
  for (const output of outputs) {
    tx.addOutput({ script: output.script, amount: output.amount });
  }
  return tx.toPSBT(0);
};

const mixedFixture = () =>
  buildMixedPsbt(
    planCase("bitcoin-psbt-every-template").request.psbt ?? "",
    planCase("bitcoin-psbt-every-template").request.inputs?.[3]?.publicKey ?? "",
  );

function btcReplay(emulator: "classic1s" | "pro"): void {
  const transcript = transcripts[emulator];
  const info = INFO_FOR[emulator];
  const replay = (name: string): Exchange => replayExchange(transcriptSession(transcript, name));

  describe(`${emulator} bitcoin psbt replay`, () => {
    it("refuses bitcoin-psbt-every-template before any exchange (mixed tx, taproot lacks prev tx)", async () => {
      const error = await thrown(() =>
        bitcoinPrepare(everyTemplatePsbt(), signPlan("bitcoin-psbt-every-template"), "mainnet", []),
      );
      expect(error.code).toBe("unsupported");
      expect(transcriptSession(transcript, "bitcoin-psbt-every-template").exchanges).toHaveLength(
        0,
      );
    });

    it("refuses bitcoin-psbt-single-anyonecanpay before any exchange", async () => {
      const { psbt } = planCase("bitcoin-psbt-single-anyonecanpay").request;
      const error = await thrown(() =>
        bitcoinPrepare(
          hex(psbt ?? ""),
          signPlan("bitcoin-psbt-single-anyonecanpay"),
          "mainnet",
          [],
        ),
      );
      expect(error.code).toBe("unsupported");
      expect(
        transcriptSession(transcript, "bitcoin-psbt-single-anyonecanpay").exchanges,
      ).toHaveLength(0);
    });

    it("signs all four script templates and every signature verifies", async () => {
      const { psbt } = mixedFixture();
      const sign = signPlan("bitcoin-psbt-every-template");
      const prepared = bitcoinPrepare(psbt, sign, "mainnet", []);
      const sigs = await signBitcoinTransaction(
        replay("bitcoin-psbt-mixed-prevtxs"),
        info,
        prepared,
      );
      expect(sigs).toHaveLength(4);
      const [tasks] = planCase("bitcoin-psbt-every-template").stages;
      if (tasks === undefined) {
        throw new Error("plan carries no tasks");
      }
      for (let i = 0; i < 4; i++) {
        const sig = sigs[i];
        const digest = sighash(psbt, i, hex(tasks[i]?.publicKey ?? ""));
        if (sig === undefined) {
          throw new Error("missing signature");
        }
        const verified =
          sign[i]?.scriptType === SPENDTAPROOT
            ? schnorrOk(digest, sig, sighashTweakedKey(psbt, i))
            : ecdsaOk(digest, sig, hex(tasks[i]?.publicKey ?? ""));
        expect(verified).toBe(true);
      }
    });

    it("signs the change-output PSBT and the signature verifies", async () => {
      const { psbt } = buildChangePsbt(planCase("bitcoin-psbt-every-template").request.psbt ?? "");
      const prepared = bitcoinPrepare(
        psbt,
        [{ index: 0, path: [H + 84, H, H, 0, 0], scriptType: 3 }],
        "mainnet",
        [{ index: 1, path: [H + 84, H, H, 1, 0], scriptType: 3 }],
      );
      const sigs = await signBitcoinTransaction(replay("bitcoin-psbt-change"), info, prepared);
      expect(sigs).toHaveLength(1);
      const [sig] = sigs;
      if (sig === undefined) {
        throw new Error("missing signature");
      }
      const [stage] = planCase("bitcoin-psbt-every-template").stages;
      const key = stage?.[2]?.publicKey;
      expect(ecdsaOk(sighash(psbt, 0, hex(key ?? "")), sig, hex(key ?? ""))).toBe(true);
    });
  });

  describe(`${emulator} bitcoin message replay`, () => {
    it("legacy message signature verifies against the plan digest and key", async () => {
      const plan = planCase("bitcoin-message-legacy");
      const sig = await signBitcoinMessage(
        replay("bitcoin-message-legacy"),
        info,
        plan.key.path,
        new TextEncoder().encode(plan.request.message ?? ""),
        { format: "legacy", scriptType: 0, network: "mainnet" },
      );
      expect(sig).toHaveLength(64);
      const [stage] = plan.stages;
      const digest = stage?.[0]?.digest;
      expect(digest).toBeDefined();
      expect(ecdsaOk(hex(digest ?? ""), sig, hex(plan.key.publicKey))).toBe(true);
    });
  });
}
btcReplay("classic1s");
btcReplay("pro");

describe("pro bitcoin BIP-322 replay", () => {
  const transcript = transcripts.pro;
  const replay = (name: string): Exchange => replayExchange(transcriptSession(transcript, name));

  it("p2wpkh witness signature verifies", async () => {
    const plan = planCase("bitcoin-message-bip322-p2wpkh");
    const sig = await signBitcoinMessage(
      replay("bitcoin-message-bip322-p2wpkh"),
      PRO_INFO,
      plan.key.path,
      new TextEncoder().encode(plan.request.message ?? ""),
      { format: "bip322-simple", scriptType: 3, network: "mainnet" },
    );
    expect(sig).toHaveLength(64);
    const [stage] = plan.stages;
    const digest = stage?.[0]?.digest;
    expect(digest).toBeDefined();
    expect(ecdsaOk(hex(digest ?? ""), sig, hex(plan.key.publicKey))).toBe(true);
  });

  it("p2tr schnorr signature verifies against the tweaked output key", async () => {
    const plan = planCase("bitcoin-message-bip322-p2tr");
    const sig = await signBitcoinMessage(
      replay("bitcoin-message-bip322-p2tr"),
      PRO_INFO,
      plan.key.path,
      new TextEncoder().encode(plan.request.message ?? ""),
      { format: "bip322-simple", scriptType: 5, network: "mainnet" },
    );
    expect(sig).toHaveLength(64);
    const [stage] = plan.stages;
    const task = stage?.[0];
    const digest = task?.message ?? task?.digest;
    expect(digest).toBeDefined();
    expect(schnorrOk(hex(digest ?? ""), sig, hex(task?.publicKey ?? ""))).toBe(true);
  });

  it("classic1s refuses BIP-322 before any exchange", async () => {
    const plan = planCase("bitcoin-message-bip322-p2wpkh");
    const error = await thrown(async () =>
      signBitcoinMessage(noExchange(), CLASSIC_INFO, plan.key.path, new Uint8Array([0x61]), {
        format: "bip322-simple",
        scriptType: 3,
        network: "mainnet",
      }),
    );
    expect(error.code).toBe("unsupported");
    expect(
      transcripts.classic1s.sessions.find((s) => s.name === "bitcoin-message-bip322-p2wpkh")
        ?.exchanges,
    ).toHaveLength(0);
  });
});

describe("bitcoinPrepare refusals", () => {
  const sign = (): BitcoinSignEntry[] => signPlan("bitcoin-psbt-every-template");

  it("rejects a malformed PSBT", async () => {
    const error = await thrown(() =>
      bitcoinPrepare(new Uint8Array([0, 1, 2]), sign(), "mainnet", []),
    );
    expect(error.code).toBe("invalid-input");
  });

  it("rejects a sign index out of range", async () => {
    const error = await thrown(() =>
      bitcoinPrepare(
        everyTemplatePsbt(),
        [...sign(), { index: 9, path: [H, H], scriptType: 0 }],
        "mainnet",
        [],
      ),
    );
    expect(error.code).toBe("invalid-input");
  });

  it("rejects a duplicated sign index", async () => {
    const error = await thrown(() =>
      bitcoinPrepare(everyTemplatePsbt(), [...sign(), sign()[0]!], "mainnet", []),
    );
    expect(error.code).toBe("invalid-input");
  });

  it("rejects a change index out of range", async () => {
    const error = await thrown(() =>
      bitcoinPrepare(everyTemplatePsbt(), sign(), "mainnet", [
        { index: 9, path: [H + 84, H, H, 1, 0], scriptType: 3 },
      ]),
    );
    expect(error.code).toBe("invalid-input");
  });

  it("rejects an unsupported input script type", async () => {
    const entries = sign().map((e) => (e.index === 1 ? { ...e, scriptType: 2 } : e));
    const { psbt } = mixedFixture();
    const error = await thrown(() => bitcoinPrepare(psbt, entries, "mainnet", []));
    expect(error.code).toBe("unsupported");
  });

  it("rejects an ANYONECANPAY sighash even with prevout data present", async () => {
    const { psbt } = mixedFixture();
    const tx = ScureTransaction.fromPSBT(psbt, { allowUnknownInputs: true });
    tx.updateInput(0, { sighashType: 0x81 });
    const error = await thrown(() => bitcoinPrepare(tx.toPSBT(0), sign(), "mainnet", []));
    expect(error.code).toBe("unsupported");
  });

  it("rejects a foreign input (missing from sign)", async () => {
    const error = await thrown(() =>
      bitcoinPrepare(everyTemplatePsbt(), sign().slice(1), "mainnet", []),
    );
    expect(error.code).toBe("unsupported");
  });

  it("rejects a duplicated change index", async () => {
    const change = { index: 1, path: [H + 84, H, H, 1, 0], scriptType: 3 };
    const error = await thrown(() =>
      bitcoinPrepare(everyTemplatePsbt(), sign(), "mainnet", [change, { ...change }]),
    );
    expect(error.code).toBe("invalid-input");
  });

  it("rejects a witness_utxo that disagrees with non_witness_utxo", async () => {
    const { psbt } = mixedFixture();
    // scure validates the pair at update time, so splice the PSBT record in raw.
    const witnessUtxo = Uint8Array.of(
      ...new Uint8Array(8), // amount 0 — disagrees with the real prevout
      0x16,
      0x00,
      0x14,
      ...new Uint8Array(20),
    );
    const patched = injectWitnessUtxo(psbt, witnessUtxo);
    const error = await thrown(() =>
      bitcoinPrepare(patched, signPlan("bitcoin-psbt-every-template"), "mainnet", []),
    );
    expect(error.code).toBe("invalid-input");
  });

  it("rejects a non_witness_utxo whose txid differs from the outpoint", async () => {
    const { psbt } = mixedFixture();
    const corrupted = corruptPrevTx(psbt);
    const error = await thrown(() =>
      bitcoinPrepare(corrupted, signPlan("bitcoin-psbt-every-template"), "mainnet", []),
    );
    expect(error.code).toBe("invalid-input");
  });

  it.each([2, 3])("rejects %i OP_RETURN outputs", async (count) => {
    const psbt = psbtWithOutputs(
      Array.from({ length: count }, () => ({
        script: Uint8Array.of(0x6a, 0x01, 0x01),
        amount: 0n,
      })),
    );
    const error = await thrown(() => bitcoinPrepare(psbt, sign().slice(0, 1), "mainnet", []));
    expect(error.code).toBe("unsupported");
  });

  it("rejects a non-zero-value OP_RETURN output", async () => {
    const psbt = psbtWithOutputs([{ script: Uint8Array.of(0x6a, 0x01, 0x01), amount: 500n }]);
    const error = await thrown(() => bitcoinPrepare(psbt, sign().slice(0, 1), "mainnet", []));
    expect(error.code).toBe("unsupported");
  });

  it("rejects an output script with no address form", async () => {
    const psbt = psbtWithOutputs([
      { script: Uint8Array.of(0x51, 0x02, 0xaa, 0xbb), amount: 1000n },
    ]);
    const error = await thrown(() => bitcoinPrepare(psbt, sign().slice(0, 1), "mainnet", []));
    expect(error.code).toBe("unsupported");
  });
});

describe("signBitcoinTransaction hostile", () => {
  const prepared = () => {
    const { psbt } = mixedFixture();
    return bitcoinPrepare(psbt, signPlan("bitcoin-psbt-every-template"), "mainnet", []);
  };
  const finished = (): Uint8Array => txRequest({ requestType: 3 });

  const run = async (responses: Uint8Array[]) => {
    const { exchange } = scripted(responses);
    return thrown(async () => signBitcoinTransaction(exchange, CLASSIC_INFO, prepared()));
  };

  // Neither firmware ever sends a hashless TXMETA (main-tx meta went out in SignTx; every
  // metadata request carries a previous/original tx hash), so the client refuses it.
  it("rejects a TXMETA without tx_hash", async () => {
    const error = await run([
      txRequest({ requestType: 2, details: { requestIndex: 0, extraDataLen: 0 } }),
    ]);
    expect(error.code).toBe("device-fault");
  });

  it("rejects a request for an unknown previous transaction hash", async () => {
    const error = await run([
      txRequest({
        requestType: 2,
        details: { requestIndex: 0, txHash: new Uint8Array(32).fill(0xaa), extraDataLen: 0 },
      }),
    ]);
    expect(error.code).toBe("device-fault");
  });

  it("rejects an out-of-range previous output index", async () => {
    const { prevTxid } = mixedFixture();
    const prevHash = hex(prevTxid);
    const error = await run([
      txRequest({
        requestType: 1,
        details: { requestIndex: 9, txHash: prevHash, extraDataLen: 0 },
      }),
    ]);
    expect(error.code).toBe("device-fault");
  });

  it("rejects an out-of-range previous input index", async () => {
    const { prevTxid } = mixedFixture();
    const prevHash = hex(prevTxid);
    const error = await run([
      txRequest({
        requestType: 0,
        details: { requestIndex: 9, txHash: prevHash, extraDataLen: 0 },
      }),
    ]);
    expect(error.code).toBe("device-fault");
  });

  it("rejects a signature index out of range or unsigned", async () => {
    const error = await run([
      txRequest({
        requestType: 0,
        details: { requestIndex: 0 },
        serialized: { signatureIndex: 9, signature: derSig(1n, 2n) },
      }),
      finished(),
    ]);
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("unexpected signature index");
  });

  it("rejects a duplicate signature", async () => {
    const sig = derSig(1n, 2n);
    const error = await run([
      txRequest({ requestType: 0, details: { requestIndex: 0 } }),
      txRequest({ requestType: 0, details: { requestIndex: 1 } }),
      txRequest({
        requestType: 0,
        details: { requestIndex: 2 },
        serialized: { signatureIndex: 0, signature: sig },
      }),
      txRequest({ requestType: 0, details: { requestIndex: 3 } }),
      txRequest({
        requestType: 0,
        details: { requestIndex: 0 },
        serialized: { signatureIndex: 0, signature: sig },
      }),
      finished(),
    ]);
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain("unexpected signature index");
  });

  it("rejects a non-DER ECDSA signature", async () => {
    const error = await run([
      txRequest({
        requestType: 0,
        details: { requestIndex: 0 },
        serialized: { signatureIndex: 0, signature: new Uint8Array(64).fill(1) },
      }),
      finished(),
    ]);
    expect(error.code).toBe("device-fault");
  });

  it("rejects a 65-byte schnorr signature", async () => {
    const error = await run([
      txRequest({
        requestType: 0,
        details: { requestIndex: 3 },
        serialized: { signatureIndex: 3, signature: new Uint8Array(65).fill(2) },
      }),
      finished(),
    ]);
    expect(error.code).toBe("device-fault");
  });

  it("rejects unsupported request types", async () => {
    for (const requestType of [4, 5, 6, 7, 99]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- requests are dispatched sequentially
      const error = await run([txRequest({ requestType })]);
      expect(error.code).toBe("device-fault");
      expect(error.message).toContain("unhandled request type");
    }
  });

  it("rejects finishing before every signed input has a signature", async () => {
    const error = await run([finished()]);
    expect(error.code).toBe("device-fault");
  });

  it("rejects a request carrying extra data", async () => {
    const error = await run([
      txRequest({ requestType: 0, details: { requestIndex: 0, extraDataLen: 4 } }),
    ]);
    expect(error.code).toBe("device-fault");
  });

  it("enforces the round bound", async () => {
    const responses: Uint8Array[] = [];
    for (let i = 0; i < 400; i++) {
      responses.push(txRequest({ requestType: 0, details: { requestIndex: 0 } }));
    }
    const error = await run(responses);
    expect(error.code).toBe("device-fault");
  });

  it("passes a replayed signature through — and it fails independent verification", async () => {
    const { psbt } = mixedFixture();
    const plan = planCase("bitcoin-psbt-every-template");
    const replay = replayExchange(
      transcriptSession(transcripts.classic1s, "bitcoin-psbt-mixed-prevtxs"),
    );
    const sigs = await signBitcoinTransaction(replay, CLASSIC_INFO, prepared());
    const [sig] = sigs;
    if (sig === undefined) {
      throw new Error("missing signature");
    }
    // A signature valid for its own digest never verifies against a different input's digest.
    expect(
      ecdsaOk(
        sighash(psbt, 1, hex(plan.stages[0]?.[1]?.publicKey ?? "")),
        sig,
        hex(plan.stages[0]?.[0]?.publicKey ?? ""),
      ),
    ).toBe(false);
  });
});

describe("signBitcoinMessage hostile", () => {
  const msg = new TextEncoder().encode("hello");
  const path = [H + 44, H, H, 0, 0];

  it.each([
    [[]],
    [[H + 44, H, H, -1]],
    [[H + 44, H, H, Number.NaN]],
    [[H + 44, H, H, 4_294_967_296]],
  ])("rejects path %j before any exchange", async (badPath) => {
    const error = await thrown(async () =>
      signBitcoinMessage(noExchange(), CLASSIC_INFO, badPath, msg, {
        format: "legacy",
        scriptType: 0,
        network: "mainnet",
      }),
    );
    expect(error.code).toBe("invalid-input");
  });

  it("rejects a legacy signature that is not 65 bytes", async () => {
    const { exchange } = scripted([
      reply(BtcMessageSignature, {
        address: "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",
        signature: new Uint8Array(64),
      }),
    ]);
    const error = await thrown(async () =>
      signBitcoinMessage(exchange, CLASSIC_INFO, path, msg, {
        format: "legacy",
        scriptType: 0,
        network: "mainnet",
      }),
    );
    expect(error.code).toBe("device-fault");
  });

  it.each([
    ["truncated varint", Uint8Array.of(0x80), "truncated varint"],
    ["no stack items", Uint8Array.of(0x00), "no usable stack items"],
    ["item length past the end", Uint8Array.of(0x02, 0x47, 0x30, 0x44), "item out of range"],
    ["empty item", Uint8Array.of(0x01, 0x00), "item out of range"],
    [
      "non-DER signature item",
      Uint8Array.of(0x02, 0x09, ...new Uint8Array(9).fill(0x30), 0x21, ...new Uint8Array(33)),
      "not a single 64-byte item",
    ],
    [
      "65-byte p2tr item",
      Uint8Array.of(0x01, 0x41, ...new Uint8Array(65).fill(1)),
      "not a single 64-byte item",
    ],
    [
      "two p2tr items",
      Uint8Array.of(0x02, 0x40, ...new Uint8Array(64), 0x40, ...new Uint8Array(64)),
      "not a single 64-byte item",
    ],
  ])("rejects a malformed BIP-322 witness (%s)", async (_label, signature, message) => {
    const bip322Path = [H + 86, H, H, 0, 0];
    const { exchange } = scripted([
      reply(BtcMessageSignature, {
        address: "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e3q4l7",
        signature,
      }),
    ]);
    const error = await thrown(async () =>
      signBitcoinMessage(exchange, PRO_INFO, bip322Path, msg, {
        format: "bip322-simple",
        scriptType: 5,
        network: "mainnet",
      }),
    );
    expect(error.code).toBe("device-fault");
    expect(error.message).toContain(message);
  });
});

describe("bitcoinDisplay", () => {
  it("is clear for acceptable requests on both emulators", () => {
    const { psbt } = mixedFixture();
    for (const info of [CLASSIC_INFO, PRO_INFO]) {
      expect(
        bitcoinDisplay(info, {
          kind: "bitcoin.psbt",
          psbt,
          network: "mainnet",
          sign: signPlan("bitcoin-psbt-every-template"),
          change: [],
        }),
      ).toBe("clear");
    }
  });

  it("is unsupported exactly where signing refuses before any exchange", async () => {
    const cases: Array<{
      psbt: Uint8Array;
      sign: BitcoinSignEntry[];
      change: BitcoinSignEntry[];
    }> = [
      {
        psbt: everyTemplatePsbt(),
        sign: signPlan("bitcoin-psbt-every-template"),
        change: [],
      },
      {
        psbt: hex(planCase("bitcoin-psbt-single-anyonecanpay").request.psbt ?? ""),
        sign: signPlan("bitcoin-psbt-single-anyonecanpay"),
        change: [],
      },
      {
        psbt: new Uint8Array([0, 1, 2]),
        sign: signPlan("bitcoin-psbt-every-template"),
        change: [],
      },
    ];
    for (const c of cases) {
      expect(
        bitcoinDisplay(CLASSIC_INFO, {
          kind: "bitcoin.psbt",
          psbt: c.psbt,
          network: "mainnet",
          sign: c.sign,
          change: c.change,
        }),
      ).toBe("unsupported");
      // oxlint-disable-next-line eslint/no-await-in-loop -- prepare refusals are asserted one case at a time
      const error = await thrown(() => bitcoinPrepare(c.psbt, c.sign, "mainnet", c.change));
      expect(["unsupported", "invalid-input"]).toContain(error.code);
    }
  });

  it("gates BIP-322 messages by firmware", () => {
    expect(bitcoinDisplay(PRO_INFO, { kind: "bitcoin.message", format: "bip322-simple" })).toBe(
      "clear",
    );
    expect(bitcoinDisplay(CLASSIC_INFO, { kind: "bitcoin.message", format: "bip322-simple" })).toBe(
      "unsupported",
    );
    expect(bitcoinDisplay(CLASSIC_INFO, { kind: "bitcoin.message", format: "legacy" })).toBe(
      "clear",
    );
  });
});

describe("TxRequest decoder fuzz", () => {
  it("arbitrary BtcTxRequest payloads yield a value or a OneKeyError", async () => {
    const { psbt } = mixedFixture();
    const prepared = bitcoinPrepare(psbt, signPlan("bitcoin-psbt-every-template"), "mainnet", []);
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 200 }), async (payload) => {
        const exchange: Exchange = async (data) => {
          void data;
          return Promise.resolve(encodeMessage(BtcTxRequest.typeId, payload));
        };
        let outcome: unknown;
        try {
          outcome = await signBitcoinTransaction(exchange, CLASSIC_INFO, prepared);
        } catch (error) {
          outcome = error;
          if (!(error instanceof OneKeyError)) {
            throw new TypeError(`non-OneKeyError thrown: ${String(error)}`, { cause: error });
          }
        }
        expect(outcome).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });
});
