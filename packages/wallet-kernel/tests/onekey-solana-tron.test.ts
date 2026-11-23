// oxlint-disable vitest/no-conditional-in-test -- plan/recorded fixtures narrow via guard throws
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
/**
 * Layer-4 Solana + TRON coverage: offline replay of the live emulator recordings with independent
 * signature verification (noble ed25519 for Solana, noble secp256k1 recovery for TRON — no kernel
 * signing code), hostile scripted exchanges for every malformed device answer, scripted refusals
 * for every rebuild rule the firmware cannot honour, and fast-check fuzzes over the
 * SolanaSignedTx/TronSignedTx payload. Digests come from vectors/chains/signing-plans.json (message
 * bytes) and sha256(rawData) for the tron self-owner variants, which the test rebuilds exactly as
 * the recorder did.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  decodeTronContract,
  decodeTronRawData,
  encodeTronContract,
  encodeTronRawData,
  tronMessageDigest,
  tronTypeUrl,
} from "@qntx/wallet-chains/tron";

import type { DeviceInfo } from "../src/modules/onekey/protocol/device.ts";
import { OneKeyError } from "../src/modules/onekey/protocol/errors.ts";
import { decodeMessage, encodeMessage } from "../src/modules/onekey/protocol/frame.ts";
import {
  Failure,
  SolanaMessageSignature,
  SolanaSignedTx,
  TronMessageSignature,
  TronSignedTx,
  TronSignTx,
} from "../src/modules/onekey/protocol/messages.ts";
import { decode, encode } from "../src/modules/onekey/protocol/proto.ts";
import type { Decoded, MessageDef } from "../src/modules/onekey/protocol/proto.ts";
import type { Exchange } from "../src/modules/onekey/protocol/session.ts";
import {
  signSolanaRawMessage,
  signSolanaTransaction,
  solanaDisplay,
} from "../src/modules/onekey/protocol/solana.ts";
import {
  signTronMessage,
  signTronTransaction,
  tronDisplay,
} from "../src/modules/onekey/protocol/tron.ts";
import { loadVectors } from "./helpers.ts";
import { replayExchange, transcriptSession } from "./onekey-emulator/index.ts";
import type { Transcript } from "./onekey-emulator/index.ts";

const H = 0x80_00_00_00;
const SOL_PATH = [H + 44, H + 501, H, H];
const TRON_PATH = [H + 44, H + 195, H, 0, 0];
const OUR_TRON = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";
const hex = hexToBytes;

const transcripts: Record<"classic1s" | "pro", Transcript> = {
  classic1s: loadVectors("onekey/emulator-classic1s.json") as Transcript,
  pro: loadVectors("onekey/emulator-pro.json") as Transcript,
};

type PlanCase = {
  name: string;
  key: { path: number[]; publicKey: string };
  request: { message?: string; rawData?: string };
};
const plans = (loadVectors("chains/signing-plans.json") as { cases: PlanCase[] }).cases;
const planCase = (name: string): PlanCase => {
  const found = plans.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`signing plan ${name} missing`);
  }
  return found;
};
const planMessage = (name: string): Uint8Array => {
  const { message } = planCase(name).request;
  if (message === undefined) {
    throw new Error(`plan ${name} carries no message`);
  }
  return hex(message);
};
const planRawData = (name: string): Uint8Array => {
  const { rawData } = planCase(name).request;
  if (rawData === undefined) {
    throw new Error(`plan ${name} carries no rawData`);
  }
  return hex(rawData);
};
const tronVectors = (
  loadVectors("chains/tron.json") as { transactions: Array<{ name: string; rawDataHex: string }> }
).transactions;
const tronVector = (name: string): Uint8Array => {
  const found = tronVectors.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`tron vector ${name} missing`);
  }
  return hex(found.rawDataHex);
};

const SOL_KEY = hex(planCase("solana-message-raw").key.publicKey);
const TRON_KEY = hex(planCase("tron-message").key.publicKey);

// The recorder's self-owner rebuild: the firmware rewrites the contract owner to its own key,
// so the input that echoes back byte-for-byte is the canonical raw_data carrying OUR_TRON.
const tronSelf = (rawData: Uint8Array): Uint8Array => {
  const raw = decodeTronRawData(rawData);
  const decoded = decodeTronContract(raw.contract.typeId, raw.contract.value);
  if (decoded === undefined) {
    throw new Error("tron case is not decodable");
  }
  const value = encodeTronContract({ ...decoded.contract, owner: OUR_TRON });
  return encodeTronRawData({ ...raw, contract: { ...raw.contract, value } });
};

const solSelf = (name: string): Uint8Array => {
  const source = planCase(name.replace("-self", "-single-signer"));
  const { message } = source.request;
  if (message === undefined) {
    throw new Error(`plan ${name} carries no message`);
  }
  const theirs = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
  return hex(message.replace(theirs, source.key.publicKey));
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Independent TRON check: recover the compressed key under both parities over the digest. */
function tronVerifies(digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64) {
    return false;
  }
  let parsed;
  try {
    parsed = secp256k1.Signature.fromBytes(signature, "compact");
  } catch {
    return false;
  }
  for (const yParity of [0, 1] as const) {
    let recovered: Uint8Array | undefined;
    try {
      recovered = parsed.addRecoveryBit(yParity).recoverPublicKey(digest).toBytes(true);
    } catch {
      recovered = undefined;
    }
    if (recovered !== undefined && equalBytes(recovered, publicKey)) {
      return true;
    }
  }
  return false;
}

async function thrown(fn: () => Promise<unknown>): Promise<OneKeyError> {
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

/** A device that serves queued encoded-message responses and records what it was sent. */
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

const INFO: DeviceInfo = {
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

const TRON_SELF_SESSIONS: Record<string, Uint8Array> = {
  "tron-transfer-self": tronSelf(planRawData("tron-transaction-trx-transfer")),
  "tron-trc20-transfer": tronSelf(tronVector("trc20-transfer")),
  "tron-delegate-energy": tronSelf(tronVector("delegate-energy")),
};

function l4Replay(emulator: "classic1s" | "pro"): void {
  const transcript = transcripts[emulator];
  const replay = (name: string): Exchange => replayExchange(transcriptSession(transcript, name));

  describe(`${emulator} solana replay`, () => {
    it.each(["solana-transaction-legacy-self", "solana-transaction-v0-self"] as const)(
      "%s returns a signature verifying against the signed message",
      async (name) => {
        const message = solSelf(name);
        const signature = await signSolanaTransaction(replay(name), SOL_PATH, message, SOL_KEY);
        expect(signature).toHaveLength(64);
        expect(ed25519.verify(signature, message, SOL_KEY)).toBe(true);
      },
    );

    it("solana-message-raw returns a signature verifying against the message", async () => {
      const message = planMessage("solana-message-raw");
      const signature = await signSolanaRawMessage(replay("solana-message-raw"), SOL_PATH, message);
      expect(signature).toHaveLength(64);
      expect(ed25519.verify(signature, message, SOL_KEY)).toBe(true);
    });

    /* The plan fee payer is not the device key: the client refuses before any exchange
       (Pro's debug build would sign anyway — its signer check is skipped in the emulator
       build; the recorded sessions stay in the vectors as evidence). */
    it.each([
      "solana-transaction-legacy-single-signer",
      "solana-transaction-v0-single-signer",
    ] as const)("%s refuses a foreign signer with zero exchanges", async (name) => {
      const error = await thrown(async () =>
        signSolanaTransaction(noExchange(), SOL_PATH, planMessage(name), SOL_KEY),
      );
      expect(error.code).toBe("invalid-input");
    });

    it("refuses a v1 message before any exchange", async () => {
      const session = transcriptSession(transcript, "solana-transaction-v1-single-signer");
      expect(session.exchanges).toHaveLength(0);
      const error = await thrown(async () =>
        signSolanaTransaction(
          replay("solana-transaction-v1-single-signer"),
          SOL_PATH,
          planMessage("solana-transaction-v1-single-signer"),
          SOL_KEY,
        ),
      );
      expect(error.code).toBe("unsupported");
    });
  });

  describe(`${emulator} tron replay`, () => {
    it.each(Object.keys(TRON_SELF_SESSIONS))(
      "%s returns a signature verifying against sha256(rawData)",
      async (name) => {
        const rawData = TRON_SELF_SESSIONS[name];
        if (rawData === undefined) {
          throw new Error(`session ${name} has no fixture`);
        }
        const signature = await signTronTransaction(replay(name), TRON_PATH, rawData, TRON_KEY);
        expect(signature).toHaveLength(64);
        expect(tronVerifies(sha256(rawData), signature, TRON_KEY)).toBe(true);
      },
    );

    it("tron-message returns a signature verifying against the V2 digest", async () => {
      const message = planMessage("tron-message");
      const signature = await signTronMessage(replay("tron-message"), INFO, TRON_PATH, message);
      expect(signature).toHaveLength(64);
      expect(tronVerifies(tronMessageDigest(message), signature, TRON_KEY)).toBe(true);
    });

    it("the plan transfer refuses a foreign owner with zero exchanges", async () => {
      const error = await thrown(async () =>
        signTronTransaction(
          noExchange(),
          TRON_PATH,
          planRawData("tron-transaction-trx-transfer"),
          TRON_KEY,
        ),
      );
      expect(error.code).toBe("invalid-input");
    });
  });
}

l4Replay("classic1s");
l4Replay("pro");

describe("signSolanaTransaction hostile", () => {
  const message = (): Uint8Array => solSelf("solana-transaction-legacy-self");

  const BAD_PATHS: ReadonlyArray<ReadonlyArray<number>> = [
    [H + 44, H + 501, H, 0],
    [],
    [H + 44, H + 501, H, 0x1_00_00_00_00],
  ];

  it.each(BAD_PATHS.map((path) => ({ path })))(
    "refuses path $path before any exchange",
    async ({ path }) => {
      const error = await thrown(async () =>
        signSolanaTransaction(noExchange(), path, message(), SOL_KEY),
      );
      expect(error.code).toBe("invalid-input");
    },
  );

  it("rejects an unparseable message before any exchange", async () => {
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signSolanaTransaction(exchange, SOL_PATH, hex("0a0b"), SOL_KEY),
    );
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it("rejects a version-1 message before any exchange", async () => {
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signSolanaTransaction(
        exchange,
        SOL_PATH,
        planMessage("solana-transaction-v1-single-signer"),
        SOL_KEY,
      ),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it.each([63, 65])("rejects a %i-byte signature as device-fault", async (length) => {
    const { exchange } = scripted([reply(SolanaSignedTx, { signature: new Uint8Array(length) })]);
    const error = await thrown(async () =>
      signSolanaTransaction(exchange, SOL_PATH, message(), SOL_KEY),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects a missing signature as device-fault", async () => {
    const { exchange } = scripted([encodeMessage(SolanaSignedTx.typeId, new Uint8Array())]);
    const error = await thrown(async () =>
      signSolanaTransaction(exchange, SOL_PATH, message(), SOL_KEY),
    );
    expect(error.code).toBe("device-fault");
  });

  it("maps the blind-sign refusal to unsupported", async () => {
    const { exchange } = scripted([
      reply(Failure, { code: 3, message: "Please confirm the BlindSign enabled" }),
    ]);
    const error = await thrown(async () =>
      signSolanaTransaction(exchange, SOL_PATH, message(), SOL_KEY),
    );
    expect(error.code).toBe("unsupported");
  });

  it("maps another DataError to unsupported without leaking the device text", async () => {
    const { exchange } = scripted([reply(Failure, { code: 3, message: "Invalid params" })]);
    const error = await thrown(async () =>
      signSolanaTransaction(exchange, SOL_PATH, message(), SOL_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(error.message).not.toContain("Invalid params");
  });
});

describe("signSolanaRawMessage hostile", () => {
  it("refuses a message that parses as a transaction before any exchange", async () => {
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signSolanaRawMessage(exchange, SOL_PATH, solSelf("solana-transaction-legacy-self")),
    );
    expect(error.code).toBe("invalid-input");
    expect(writes).toHaveLength(0);
  });

  it.each([63, 65])("rejects a %i-byte signature as device-fault", async (length) => {
    const { exchange } = scripted([
      reply(SolanaMessageSignature, { signature: new Uint8Array(length) }),
    ]);
    const error = await thrown(async () =>
      signSolanaRawMessage(exchange, SOL_PATH, new TextEncoder().encode("hello")),
    );
    expect(error.code).toBe("device-fault");
  });
});

describe("solanaDisplay", () => {
  it("classifies transactions", () => {
    // The fixture is a plain System-program transfer — both firmwares describe it in full.
    expect(
      solanaDisplay(
        {
          kind: "solana.transaction",
          message: solSelf("solana-transaction-legacy-self"),
        },
        SOL_KEY,
      ),
    ).toBe("clear");
    // Every versioned message gets the blind hash screen.
    expect(
      solanaDisplay(
        {
          kind: "solana.transaction",
          message: planMessage("solana-transaction-v0-single-signer"),
        },
        SOL_KEY,
      ),
    ).toBe("blind");
    expect(solanaDisplay({ kind: "solana.transaction", message: hex("0a0b") }, SOL_KEY)).toBe(
      "blind",
    );
    // A legacy message over an unknown program: blind (only the clear-set programs render).
    const unknownProgram = solSelf("solana-transaction-legacy-self");
    unknownProgram.fill(0x09, 68, 100);
    expect(solanaDisplay({ kind: "solana.transaction", message: unknownProgram }, SOL_KEY)).toBe(
      "blind",
    );
  });

  it("classifies raw messages by printability", () => {
    expect(
      solanaDisplay(
        { kind: "solana.message", message: new TextEncoder().encode("pay rent") },
        SOL_KEY,
      ),
    ).toBe("clear");
    expect(solanaDisplay({ kind: "solana.message", message: hex("00ff10") }, SOL_KEY)).toBe(
      "blind",
    );
    // Valid UTF-8 with a control character: hex dump, so blind.
    expect(
      solanaDisplay(
        {
          kind: "solana.message",
          message: new TextEncoder().encode("hithere"),
        },
        SOL_KEY,
      ),
    ).toBe("blind");
    // Valid UTF-8 with no printable ASCII (pure CJK): the device shows hex, so blind.
    expect(
      solanaDisplay(
        {
          kind: "solana.message",
          message: new TextEncoder().encode(""),
        },
        SOL_KEY,
      ),
    ).toBe("blind");
    // Sign refuses a v1 message with unsupported and zero exchanges — display must agree.
    expect(
      solanaDisplay(
        {
          kind: "solana.transaction",
          message: planMessage("solana-transaction-v1-single-signer"),
        },
        SOL_KEY,
      ),
    ).toBe("unsupported");
  });
});

describe("signTronTransaction hostile", () => {
  const rawData = (): Uint8Array => TRON_SELF_SESSIONS["tron-transfer-self"] ?? new Uint8Array();

  it.each([64, 66])("rejects a %i-byte signature as device-fault", async (length) => {
    const { exchange } = scripted([
      reply(TronSignedTx, { signature: new Uint8Array(length), serializedTx: rawData() }),
    ]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, rawData(), TRON_KEY),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects a serialized_tx mismatch as device-fault", async () => {
    const { exchange } = scripted([
      reply(TronSignedTx, {
        signature: new Uint8Array(65),
        serializedTx: TRON_SELF_SESSIONS["tron-delegate-energy"] ?? new Uint8Array(),
      }),
    ]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, rawData(), TRON_KEY),
    );
    expect(error.code).toBe("device-fault");
  });

  it("rejects a missing serialized_tx as device-fault", async () => {
    const { exchange } = scripted([reply(TronSignedTx, { signature: new Uint8Array(65) })]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, rawData(), TRON_KEY),
    );
    expect(error.code).toBe("device-fault");
  });

  it("passes a well-formed foreign signature through — the caller's verify is the guard", async () => {
    // A hostile device can echo the raw_data yet sign a different digest; the client cannot
    // detect it (the driver layer assembles/verifies), so the client passes it through.
    const { exchange } = scripted([
      reply(TronSignedTx, { signature: new Uint8Array(65).fill(7), serializedTx: rawData() }),
    ]);
    const signature = await signTronTransaction(exchange, TRON_PATH, rawData(), TRON_KEY);
    expect(signature).toHaveLength(64);
    expect(tronVerifies(sha256(rawData()), signature, TRON_KEY)).toBe(false);
  });

  it.each(["trc10-transfer", "account-permission-update"])(
    "refuses the %s contract before any exchange",
    async (name) => {
      const { exchange, writes } = scripted([]);
      const error = await thrown(async () =>
        signTronTransaction(exchange, TRON_PATH, tronVector(name), TRON_KEY),
      );
      expect(error.code).toBe("unsupported");
      expect(writes).toHaveLength(0);
    },
  );

  it("refuses a freeze-v1 contract it cannot decode canonically", async () => {
    // Type 11 is in the firmware set but not in the wallet-chains decoder; without a decode
    // the client cannot prove the rebuild — refusal is the safe answer.
    const raw = decodeTronRawData(rawData());
    const frozen = encodeTronRawData({
      ...raw,
      contract: {
        ...raw.contract,
        typeId: 11,
        typeUrl: tronTypeUrl("FreezeBalanceContract"),
      },
    });
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, frozen, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses raw_data carrying an unknown field before any exchange", async () => {
    // Field 15 appended to otherwise-valid raw_data decodes into `extra`; the firmware's
    // serialize() drops extras, so the rebuild would differ.
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(
        exchange,
        TRON_PATH,
        new Uint8Array([...rawData(), 0x7a, 0x01, 0xaa]),
        TRON_KEY,
      ),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses a zero-amount transfer before any exchange", async () => {
    const raw = decodeTronRawData(rawData());
    const decoded = decodeTronContract(raw.contract.typeId, raw.contract.value);
    if (decoded === undefined || decoded.contract.type !== "TransferContract") {
      throw new Error("fixture is not a transfer");
    }
    const value = encodeTronContract({ ...decoded.contract, amount: 0n });
    const zeroed = encodeTronRawData({ ...raw, contract: { ...raw.contract, value } });
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, zeroed, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses raw_data without a timestamp", async () => {
    // The wire field is required: without one the device writes timestamp 0, which is not the
    // requested raw_data — refuse rather than echo-fault after the user confirmed.
    const raw = decodeTronRawData(rawData());
    const { timestamp: _dropped, ...rest } = raw;
    const timeless = encodeTronRawData(rest);
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, timeless, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses a contract slot carrying an unknown field", async () => {
    // The slot's extras re-encode verbatim: fields 3/4 are provider/contract_name, 5
    // permission_id — a made-up field 7 is one the firmware cannot rebuild.
    const raw = decodeTronRawData(rawData());
    const widened = encodeTronRawData({
      ...raw,
      contract: {
        ...raw.contract,
        extra: [
          ...raw.contract.extra,
          { field: 7, wire: 0, bytes: hex("3801"), varint: 1n, data: undefined },
        ],
      },
    });
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, widened, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses a zero-count vote", async () => {
    const raw = decodeTronRawData(tronSelf(tronVector("vote-witness")));
    const decoded = decodeTronContract(raw.contract.typeId, raw.contract.value);
    if (decoded === undefined || decoded.contract.type !== "VoteWitnessContract") {
      throw new Error("fixture is not a vote");
    }
    const [first, ...rest] = decoded.contract.votes;
    if (first === undefined) {
      throw new Error("fixture has no votes");
    }
    const value = encodeTronContract({
      ...decoded.contract,
      votes: [{ ...first, count: 0n }, ...rest],
    });
    const zeroed = encodeTronRawData({ ...raw, contract: { ...raw.contract, value } });
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, zeroed, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses a zero-balance delegate", async () => {
    const raw = decodeTronRawData(tronSelf(tronVector("delegate-energy")));
    const decoded = decodeTronContract(raw.contract.typeId, raw.contract.value);
    if (decoded === undefined || decoded.contract.type !== "DelegateResourceContract") {
      throw new Error("fixture is not a delegate");
    }
    const value = encodeTronContract({ ...decoded.contract, balance: 0n });
    const zeroed = encodeTronRawData({ ...raw, contract: { ...raw.contract, value } });
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, zeroed, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses a trigger with sub-4-byte call data", async () => {
    const raw = decodeTronRawData(tronSelf(tronVector("trc20-transfer")));
    const decoded = decodeTronContract(raw.contract.typeId, raw.contract.value);
    if (decoded === undefined || decoded.contract.type !== "TriggerSmartContract") {
      throw new Error("fixture is not a trigger");
    }
    const value = encodeTronContract({ ...decoded.contract, data: new Uint8Array(2) });
    const shortened = encodeTronRawData({ ...raw, contract: { ...raw.contract, value } });
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, shortened, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses a token id without a call token value", async () => {
    // The firmware writes asset_id only alongside call_token_value — a bare token id cannot
    // be rebuilt.
    const raw = decodeTronRawData(tronSelf(tronVector("trc20-transfer")));
    const decoded = decodeTronContract(raw.contract.typeId, raw.contract.value);
    if (decoded === undefined || decoded.contract.type !== "TriggerSmartContract") {
      throw new Error("fixture is not a trigger");
    }
    const value = encodeTronContract({ ...decoded.contract, tokenId: 100n });
    const widened = encodeTronRawData({ ...raw, contract: { ...raw.contract, value } });
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, widened, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("refuses a contract value carrying an unknown field", async () => {
    // Field 9 appended to the contract value (fields 1/2/3 precede it, so the encoding stays
    // canonical) lands in the decode's `extra` — the firmware cannot emit it back.
    const raw = decodeTronRawData(rawData());
    const widened = encodeTronRawData({
      ...raw,
      contract: {
        ...raw.contract,
        value: new Uint8Array([...raw.contract.value, 0x48, 0x01]),
      },
    });
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () =>
      signTronTransaction(exchange, TRON_PATH, widened, TRON_KEY),
    );
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });

  it("omits zero-valued optional scalars the firmware drops", async () => {
    // freeze-v2-bandwidth has resource 0 (BANDWIDTH): the firmware only writes the field when
    // it is nonzero, so the request must not carry it either — else the rebuild differs.
    const { exchange, writes } = scripted([
      reply(TronSignedTx, {
        signature: new Uint8Array(65),
        serializedTx: tronSelf(tronVector("freeze-v2-bandwidth")),
      }),
    ]);
    const rawData = tronSelf(tronVector("freeze-v2-bandwidth"));
    await signTronTransaction(exchange, TRON_PATH, rawData, TRON_KEY);
    const [written] = writes;
    if (written === undefined) {
      throw new Error("no request written");
    }
    const request = decode(TronSignTx, decodeMessage(written).payload);
    expect(request.contract?.freezeBalanceV2Contract?.resource).toBeUndefined();
    expect(request.feeLimit).toBeUndefined();
    expect(request.contract?.permissionId).toBeUndefined();
  });
});

describe("signTronMessage hostile", () => {
  const message = hex("aa5500");

  it.each([64, 66])("rejects a %i-byte signature as device-fault", async (length) => {
    const { exchange } = scripted([
      reply(TronMessageSignature, {
        address: hex(`41${"00".repeat(20)}`),
        signature: new Uint8Array(length),
      }),
    ]);
    const error = await thrown(async () => signTronMessage(exchange, INFO, TRON_PATH, message));
    expect(error.code).toBe("device-fault");
  });

  it("gates message signing on tron-message-v2 support", async () => {
    const mini: DeviceInfo = { ...INFO, model: "mini", firmware: [3, 21, 0] };
    const { exchange, writes } = scripted([]);
    const error = await thrown(async () => signTronMessage(exchange, mini, TRON_PATH, message));
    expect(error.code).toBe("unsupported");
    expect(writes).toHaveLength(0);
  });
});

describe("tronDisplay", () => {
  it.each([
    "trx-transfer",
    "delegate-energy",
    "vote-witness",
    "withdraw-balance",
    "cancel-all-unfreeze-v2",
  ])("classifies %s as clear", (name) => {
    expect(
      tronDisplay({ kind: "tron.transaction", rawData: tronSelf(tronVector(name)) }, TRON_KEY),
    ).toBe("clear");
  });

  it.each(["trc20-transfer", "trc20-approve"])("classifies %s as blind", (name) => {
    expect(tronDisplay({ kind: "tron.transaction", rawData: tronVector(name) }, TRON_KEY)).toBe(
      "blind",
    );
  });

  it("classifies messages clear and unparseable raw_data blind", () => {
    expect(tronDisplay({ kind: "tron.message" }, TRON_KEY)).toBe("clear");
    // Sign refuses these contract types with unsupported and zero exchanges — display agrees.
    for (const name of ["trc10-transfer", "account-permission-update"]) {
      expect(tronDisplay({ kind: "tron.transaction", rawData: tronVector(name) }, TRON_KEY)).toBe(
        "unsupported",
      );
    }
    expect(tronDisplay({ kind: "tron.transaction", rawData: hex("0a0b") }, TRON_KEY)).toBe("blind");
  });
});

describe("response decoder fuzz", () => {
  it("arbitrary SolanaSignedTx payloads yield a value or a OneKeyError", async () => {
    const message = solSelf("solana-transaction-legacy-self");
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 200 }), async (payload) => {
        const exchange: Exchange = async (data) => {
          void data;
          return Promise.resolve(encodeMessage(SolanaSignedTx.typeId, payload));
        };
        let outcome: unknown;
        try {
          outcome = await signSolanaTransaction(exchange, SOL_PATH, message, SOL_KEY);
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

  it("arbitrary TronSignedTx payloads yield a value or a OneKeyError", async () => {
    const rawData = TRON_SELF_SESSIONS["tron-transfer-self"] ?? new Uint8Array();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 200 }), async (payload) => {
        const exchange: Exchange = async (data) => {
          void data;
          return Promise.resolve(encodeMessage(TronSignedTx.typeId, payload));
        };
        let outcome: unknown;
        try {
          outcome = await signTronTransaction(exchange, TRON_PATH, rawData, TRON_KEY);
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
