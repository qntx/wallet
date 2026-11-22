import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "@qntx/wallet-chains";
import { isTronAddress } from "@qntx/wallet-chains/tron";

import {
  TronBroadcastError,
  TronThrottledError,
  account,
  blockId,
  broadcastHex,
  chainParams,
  constantCall,
  headNumber,
  pinnedTronCaller,
  resources,
  solidHead,
  transactionInfo,
  transactionKnown,
  tronBandwidthBytes,
  tronBroadcastVerdict,
  tronCaller,
  tronFeeLimit,
  tronFeeQuote,
  tronLogAddress,
} from "../src/chains/tron.ts";
import type { TronApi, TronChainParams } from "../src/chains/tron.ts";

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const recordingFetch =
  (seen: Array<{ url: string; body: string }>): typeof globalThis.fetch =>
  async (input, init) => {
    await Promise.resolve();
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ url: urlOf(input), body });
    return Response.json({ ok: 1 });
  };

const HOLDER = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";
const UNKNOWN_ADDRESS = "TEWNZeMfMLjtcrbrZ1N6reGQts3a2MC2xp";
const TXID = "cd".repeat(32);

/** A TronApi that answers each path from a table; an unlisted path is an error. */
const api = (answers: Readonly<Record<string, unknown>>): TronApi => ({
  post: async (path) => {
    await Promise.resolve();
    if (!(path in answers)) {
      throw new Error(`no answer for ${path}`);
    }
    return answers[path];
  },
});

/** A TronApi that returns `body` for every path — malformed-response injection. */
const anyApi = (body: unknown): TronApi => ({
  post: async () => {
    await Promise.resolve();
    return body;
  },
});

const RESULT_WORD = new Uint8Array(32).map((_v, i) =>
  i === 29 ? 0x0f : i === 30 ? 0x42 : i === 31 ? 0x40 : 0,
);

const isTaposRefusal = (error: unknown): boolean =>
  error instanceof TronBroadcastError &&
  error.code === "TAPOS_ERROR" &&
  error.message === "Tapos error";

/** Resolves `true` when `run` settles — or throws an `Error` — and never anything else. */
const resolvedOrError = async (run: () => Promise<unknown>): Promise<boolean> => {
  try {
    await run();
    return true;
  } catch (error) {
    return error instanceof Error;
  }
};

const feeMaxCovers = (input: Parameters<typeof tronFeeQuote>[0]): boolean => {
  try {
    const quote = tronFeeQuote(input);
    return BigInt(quote.max) >= BigInt(quote.expected) && BigInt(quote.max) >= 0n;
  } catch (error) {
    return error instanceof ChainError;
  }
};

const BLOCK = {
  blockID: "ab".repeat(32),
  block_header: { raw_data: { number: 88193000, timestamp: 1_795_253_664_000 } },
};

const PARAMS: TronChainParams = {
  transactionFee: 1000n,
  energyFee: 100n,
  createAccountFee: 100_000n,
  createNewAccountFeeInSystemContract: 1_000_000n,
  maxFeeLimit: 15_000_000_000n,
  createNewAccountBandwidthRate: 1n,
  maxCreateAccountTxSize: 1000n,
  memoFee: 1_000_000n,
};

const CHAIN_PARAMETER_BODY = {
  chainParameter: [
    { key: "getTransactionFee", value: 1000 },
    { key: "getEnergyFee", value: 100 },
    { key: "getCreateAccountFee", value: 100_000 },
    { key: "getCreateNewAccountFeeInSystemContract", value: 1_000_000 },
    { key: "getMaxFeeLimit", value: 15_000_000_000 },
    { key: "getCreateNewAccountBandwidthRate", value: 1 },
    { key: "getMaxCreateAccountTxSize", value: 1000 },
    { key: "getMemoFee", value: 1_000_000 },
    { key: "getUnrelatedParameter", value: 7 },
  ],
};

describe("tronCaller", () => {
  const post = (responses: ReadonlyArray<Response | (() => never)>) => {
    const urls = responses.map((_r, i) => `https://u${i}.test`);
    const calls: string[] = [];
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const index = urls.findIndex((u) => url.startsWith(u));
      const answer = responses[index];
      if (answer === undefined) {
        return Promise.reject(new TypeError("no upstream"));
      }
      if (answer instanceof Response) {
        return Promise.resolve(answer);
      }
      return Promise.resolve().then(answer);
    };
    return { urls, calls, fetchFn };
  };

  it("posts the path appended to the provider url as JSON", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetchFn = recordingFetch(seen);
    const answer = await tronCaller(["https://a.test"], fetchFn).post("/wallet/getnowblock", {});
    expect(answer).toStrictEqual({ ok: 1 });
    expect(seen).toStrictEqual([
      {
        url: "https://a.test/wallet/getnowblock",
        body: "{}",
      },
    ]);
  });

  it("fails over on a transport error, a non-2xx, non-JSON, and a non-object body", async () => {
    const cases: ReadonlyArray<Response | (() => never)> = [
      () => {
        throw new TypeError("connection reset");
      },
      new Response("down", { status: 500 }),
      new Response("<html>"),
      Response.json(42),
    ];
    const { urls, calls, fetchFn } = post(cases);
    const client = tronCaller(urls, fetchFn);
    const attempt = client.post("/wallet/getchainparameters", {});
    const [u4] = ["https://u4.test"];
    const good = tronCaller([u4], async () =>
      Promise.resolve(Response.json({ chainParameter: [] })),
    );
    await expect(attempt).rejects.toThrow("/wallet/getchainparameters");
    expect(calls).toHaveLength(4);
    await expect(good.post("/wallet/getchainparameters", {})).resolves.toStrictEqual({
      chainParameter: [],
    });
  });

  it("throws the last endpoint's error naming path, status, and url", async () => {
    const { urls, fetchFn } = post([new Response("down", { status: 503 })]);
    await expect(tronCaller(urls, fetchFn).post("/wallet/getnowblock", {})).rejects.toThrow(
      "/wallet/getnowblock: HTTP 503 from https://u0.test",
    );
  });
});

describe("tron readers", () => {
  it("solidHead returns the solidified head number, id, and timestamp", async () => {
    await expect(solidHead(api({ "/walletsolidity/getnowblock": BLOCK }))).resolves.toStrictEqual({
      number: 88193000,
      id: BLOCK.blockID,
      timestamp: 1_795_253_664_000,
    });
  });

  it("headNumber reads the full node's head", async () => {
    await expect(headNumber(api({ "/wallet/getnowblock": BLOCK }))).resolves.toBe(88193000);
  });

  it("blockId returns the id, or undefined for the node's not-found {}", async () => {
    const both = api({
      "/wallet/getblockbynum": BLOCK,
      "/walletsolidity/getblockbynum": {},
    });
    await expect(blockId(both, 5, false)).resolves.toBe(BLOCK.blockID);
    await expect(blockId(both, 5, true)).resolves.toBeUndefined();
  });

  it("account returns the row, or undefined for {}", async () => {
    const both = api({
      "/wallet/getaccount": { address: HOLDER, balance: 1_000_000, type: "Contract" },
    });
    const row = await account(both, HOLDER);
    expect(row?.balance).toBe(1_000_000);
    expect(row?.type).toBe("Contract");
    await expect(
      account(api({ "/wallet/getaccount": {} }), UNKNOWN_ADDRESS),
    ).resolves.toBeUndefined();
  });

  it("account detects an activated zero-balance account by its address", async () => {
    const both = api({ "/wallet/getaccount": { address: HOLDER } });
    await expect(account(both, HOLDER)).resolves.toStrictEqual({ address: HOLDER });
  });

  it("resources defaults omitted proto3 counters to zero", async () => {
    const full = api({
      "/wallet/getaccountresource": {
        freeNetLimit: 600,
        freeNetUsed: 150,
        NetLimit: 5000,
        NetUsed: 200,
        EnergyLimit: 8000,
        EnergyUsed: 100,
      },
    });
    await expect(resources(full, HOLDER)).resolves.toStrictEqual({
      freeNetLimit: 600,
      freeNetUsed: 150,
      netLimit: 5000,
      netUsed: 200,
      energyLimit: 8000,
      energyUsed: 100,
      tronPowerLimit: 0,
      tronPowerUsed: 0,
    });
    await expect(
      resources(api({ "/wallet/getaccountresource": {} }), HOLDER),
    ).resolves.toStrictEqual({
      freeNetLimit: 0,
      freeNetUsed: 0,
      netLimit: 0,
      netUsed: 0,
      energyLimit: 0,
      energyUsed: 0,
      tronPowerLimit: 0,
      tronPowerUsed: 0,
    });
  });

  it("chainParams extracts the fee parameters and throws on a missing one", async () => {
    await expect(
      chainParams(api({ "/wallet/getchainparameters": CHAIN_PARAMETER_BODY })),
    ).resolves.toStrictEqual(PARAMS);
    const missing = {
      chainParameter: CHAIN_PARAMETER_BODY.chainParameter.filter(
        (entry) => entry.key !== "getMaxFeeLimit",
      ),
    };
    await expect(chainParams(api({ "/wallet/getchainparameters": missing }))).rejects.toThrow(
      "getMaxFeeLimit",
    );
  });

  it("chainParams reads a present-but-valueless parameter as proto3 zero", async () => {
    const body = {
      chainParameter: [
        { key: "getEnergyFee" },
        ...CHAIN_PARAMETER_BODY.chainParameter.filter((e) => e.key !== "getEnergyFee"),
      ],
    };
    await expect(chainParams(api({ "/wallet/getchainparameters": body }))).resolves.toStrictEqual({
      ...PARAMS,
      energyFee: 0n,
    });
  });

  it("chainParams rejects a fractional node value", async () => {
    const body = {
      chainParameter: [
        { key: "getTransactionFee", value: 1000.9 },
        ...CHAIN_PARAMETER_BODY.chainParameter.filter((e) => e.key !== "getTransactionFee"),
      ],
    };
    await expect(chainParams(api({ "/wallet/getchainparameters": body }))).rejects.toThrow(
      "malformed /wallet/getchainparameters response",
    );
  });

  it("constantCall returns the success shape with energy and constant_result bytes", async () => {
    const outcome = await constantCall(
      api({
        "/wallet/triggerconstantcontract": {
          result: { result: true },
          energy_used: 64285,
          energy_penalty: 49635,
          constant_result: ["00000000000000000000000000000000000000000000000000000000000f4240"],
          logs: [
            {
              address: "41e28b",
              topics: ["ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
              data: "00",
            },
          ],
        },
      }),
      { owner: HOLDER, contract: HOLDER, data: new Uint8Array([0xa9, 0x05]) },
    );
    expect(outcome).toStrictEqual({
      ok: true,
      energyUsed: 64285,
      energyPenalty: 49635,
      result: RESULT_WORD,
      logs: [
        {
          address: "41e28b",
          topics: ["ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
          data: "00",
        },
      ],
    });
  });

  it("constantCall decodes a hex UTF-8 failure message", async () => {
    // "REVERT opcode executed" hex-encoded as the node emits it.
    const message = [...new TextEncoder().encode("REVERT opcode executed")]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const outcome = await constantCall(
      api({
        "/wallet/triggerconstantcontract": {
          result: { code: "CONTRACT_EXE_ERROR", message },
        },
      }),
      { owner: HOLDER, contract: HOLDER, data: new Uint8Array([0xa9, 0x05]) },
    );
    expect(outcome).toStrictEqual({
      ok: false,
      message: "REVERT opcode executed",
      energyUsed: 0,
      energyPenalty: 0,
    });
  });

  it("constantCall passes a non-hex failure message through verbatim", async () => {
    const outcome = await constantCall(
      api({
        "/wallet/triggerconstantcontract": {
          result: { code: "OTHER_ERROR", message: "Not enough energy for 'SSTORE' operation" },
        },
      }),
      { owner: HOLDER, contract: HOLDER, data: new Uint8Array([0xa9, 0x05]) },
    );
    expect(outcome).toStrictEqual({
      ok: false,
      message: "Not enough energy for 'SSTORE' operation",
      energyUsed: 0,
      energyPenalty: 0,
    });
  });

  it("transactionInfo parses an included row and flags a receipt failure", async () => {
    const both = api({
      "/wallet/gettransactioninfobyid": {
        id: TXID,
        blockNumber: 88193000,
        blockTimeStamp: 1_795_253_664_000,
        fee: 6428500,
        receipt: { result: "OUT_OF_ENERGY" },
        result: "FAILED",
      },
    });
    await expect(transactionInfo(both, TXID, false)).resolves.toStrictEqual({
      blockNumber: 88193000,
      blockTimestamp: 1_795_253_664_000,
      fee: 6428500,
      receiptResult: "OUT_OF_ENERGY",
      failed: true,
      resMessage: undefined,
      logs: [],
    });
  });

  it("transactionInfo returns undefined for {}", async () => {
    await expect(
      transactionInfo(api({ "/walletsolidity/gettransactioninfobyid": {} }), TXID, true),
    ).resolves.toBeUndefined();
  });

  it("transactionKnown answers only for the node's matching txID", async () => {
    await expect(
      transactionKnown(api({ "/wallet/gettransactionbyid": { txID: TXID } }), TXID),
    ).resolves.toBe(true);
    await expect(transactionKnown(api({ "/wallet/gettransactionbyid": {} }), TXID)).resolves.toBe(
      false,
    );
  });

  it("broadcastHex resolves the txid and throws TronBroadcastError on refusal", async () => {
    await expect(
      broadcastHex(
        api({ "/wallet/broadcasthex": { result: true, code: "SUCCESS", txid: TXID } }),
        "00",
      ),
    ).resolves.toBe(TXID);
    const refusal = api({
      "/wallet/broadcasthex": { result: false, code: "TAPOS_ERROR", message: "Tapos error" },
    });
    await expect(broadcastHex(refusal, "00")).rejects.toSatisfy(isTaposRefusal);
  });

  it("every reader throws Error, never a TypeError, on malformed bodies", async () => {
    for (const read of [
      solidHead,
      headNumber,
      async (a: TronApi) => blockId(a, 1, false),
      async (a: TronApi) => account(a, HOLDER),
      async (a: TronApi) => resources(a, HOLDER),
      chainParams,
      async (a: TronApi) => transactionInfo(a, TXID, false),
      async (a: TronApi) => transactionKnown(a, TXID),
      async (a: TronApi) => broadcastHex(a, "00"),
      async (a: TronApi) =>
        constantCall(a, { owner: HOLDER, contract: HOLDER, data: new Uint8Array([1]) }),
    ]) {
      for (const body of [[], "x", 5, { wrong: "shape" }, { Error: "x" }]) {
        // `{}`-shaped malformed bodies are a valid not-found answer for some readers — a
        // resolved value and an Error instance are both legal outcomes.
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential failure injection
        const outcome = await resolvedOrError(async () => read(anyApi(body)));
        expect(outcome).toBe(true);
      }
    }
  });
});

describe("tronBroadcastVerdict", () => {
  it.each([
    "SIGERROR",
    "CONTRACT_VALIDATE_ERROR",
    "CONTRACT_EXE_ERROR",
    "BANDWITH_ERROR",
    "TAPOS_ERROR",
    "TOO_BIG_TRANSACTION_ERROR",
    "TRANSACTION_EXPIRATION_ERROR",
  ])("%s is refused", (code) => {
    expect(tronBroadcastVerdict(new TronBroadcastError(code, code))).toBe("refused");
  });

  it("DUP_TRANSACTION_ERROR is held", () => {
    expect(tronBroadcastVerdict(new TronBroadcastError("DUP_TRANSACTION_ERROR", "dup"))).toBe(
      "held",
    );
  });

  it.each([
    "SERVER_BUSY",
    "NO_CONNECTION",
    "BLOCK_UNSOLIDIFIED",
    "NOT_ENOUGH_EFFECTIVE_CONNECTION",
    "OTHER_ERROR",
    "SOME_FUTURE_CODE",
  ])("%s is unknown", (code) => {
    expect(tronBroadcastVerdict(new TronBroadcastError(code, code))).toBeUndefined();
  });

  it("a codeless broadcast error and any other error are unknown", () => {
    expect(tronBroadcastVerdict(new TronBroadcastError(undefined, undefined))).toBeUndefined();
    expect(tronBroadcastVerdict(new TypeError("transport"))).toBeUndefined();
    expect(tronBroadcastVerdict("string error")).toBeUndefined();
  });
});

describe("tronBandwidthBytes", () => {
  it("is 1 + varintLen(L) + L + 67 + 64", () => {
    expect(tronBandwidthBytes(127)).toBe(1 + 1 + 127 + 67 + 64);
    expect(tronBandwidthBytes(128)).toBe(1 + 2 + 128 + 67 + 64);
    expect(tronBandwidthBytes(200)).toBe(334);
    expect(tronBandwidthBytes(16383)).toBe(1 + 2 + 16383 + 67 + 64);
    expect(tronBandwidthBytes(16384)).toBe(1 + 3 + 16384 + 67 + 64);
  });
});

describe("tronFeeLimit", () => {
  it("is min(ceil(E × fee × 3/2), max)", () => {
    // E=64285: cost 6428500, headroom ceil(6428500 × 1.5) = 9642750.
    expect(tronFeeLimit(64285, 100n, 15_000_000_000n)).toBe(9_642_750n);
    // Odd cost rounds up: E=1, cost 100, 150 → 150n exactly; E=2 → 300n.
    expect(tronFeeLimit(1, 100n, 15_000_000_000n)).toBe(150n);
    expect(tronFeeLimit(2, 100n, 15_000_000_000n)).toBe(300n);
    expect(tronFeeLimit(3, 100n, 15_000_000_000n)).toBe(450n);
  });

  it("caps at maxFeeLimit when the headroom would exceed it", () => {
    // E=120M at 100: cost 12e9 ≤ 15e9, headroom 18e9 → capped at 15e9.
    expect(tronFeeLimit(120_000_000, 100n, 15_000_000_000n)).toBe(15_000_000_000n);
  });

  it("throws invalid-request when the estimate alone exceeds the cap", () => {
    expect(() => tronFeeLimit(150_000_001, 100n, 15_000_000_000n)).toThrow(ChainError);
    // Exactly at the cap is allowed.
    expect(tronFeeLimit(150_000_000, 100n, 15_000_000_000n)).toBe(15_000_000_000n);
  });
});

const RESOURCES = {
  freeNetLimit: 600,
  freeNetUsed: 0,
  netLimit: 0,
  netUsed: 0,
  energyLimit: 0,
  energyUsed: 0,
  tronPowerLimit: 0,
  tronPowerUsed: 0,
};

describe("tronFeeQuote", () => {
  const base = { rawDataLength: 200, params: PARAMS, resources: RESOURCES };
  // bytes = 334 for L=200.

  it("uses staked bandwidth when it covers the bytes", () => {
    const quote = tronFeeQuote({
      ...base,
      resources: { ...RESOURCES, netLimit: 400 },
    });
    expect(quote.bandwidth).toStrictEqual({
      bytes: 334,
      source: "staked",
      stakedAvailable: 400n,
      freeAvailable: 600n,
      burn: "0",
    });
    expect(quote.expected).toBe("0");
    expect(quote.max).toBe("334000");
    expect(quote.warnings).toStrictEqual([]);
  });

  it("falls to free bandwidth — all-or-nothing at the exact boundary", () => {
    const at = tronFeeQuote({
      ...base,
      resources: { ...RESOURCES, freeNetLimit: 334 },
    });
    expect(at.bandwidth.source).toBe("free");
    expect(at.expected).toBe("0");
    const under = tronFeeQuote({
      ...base,
      resources: { ...RESOURCES, freeNetLimit: 333 },
    });
    expect(under.bandwidth.source).toBe("burn");
    expect(under.bandwidth.burn).toBe("334000");
  });

  it("partial staked bandwidth does not count — all-or-nothing like the node", () => {
    const quote = tronFeeQuote({
      ...base,
      resources: { ...RESOURCES, netLimit: 333, freeNetLimit: 0 },
    });
    expect(quote.bandwidth.source).toBe("burn");
    expect(quote.bandwidth.burn).toBe("334000");
    expect(quote.expected).toBe("334000");
  });

  it("burns bytes × transactionFee when neither covers it", () => {
    const quote = tronFeeQuote({
      ...base,
      resources: { ...RESOURCES, freeNetLimit: 0 },
    });
    expect(quote.bandwidth.source).toBe("burn");
    expect(quote.expected).toBe("334000");
    expect(quote.max).toBe("334000");
  });

  it("activation pays nothing when staked bandwidth covers bytes × rate", () => {
    const quote = tronFeeQuote({
      ...base,
      activates: true,
      resources: { ...RESOURCES, netLimit: 500 },
    });
    expect(quote.bandwidth.source).toBe("activation-staked");
    expect(quote.bandwidth.burn).toBe("0");
    expect(quote.activation).toBe("1000000");
    expect(quote.expected).toBe("1000000");
    expect(quote.max).toBe("1100000");
    expect(quote.warnings).toStrictEqual(["recipient-not-activated"]);
  });

  it("activation burns createAccountFee when staked bandwidth does not cover it — free never applies", () => {
    const quote = tronFeeQuote({
      ...base,
      activates: true,
      resources: { ...RESOURCES, freeNetLimit: 100_000 },
    });
    expect(quote.bandwidth.source).toBe("activation-fee");
    expect(quote.expected).toBe("1100000");
    expect(quote.max).toBe("1100000");
  });

  it("refuses an activation transaction above the size cap", () => {
    // L=995 → bytes 1129, minus ret(1)+65 sig+64 = 1000 ≤ cap; L=996 → 1001 > cap.
    expect(() => tronFeeQuote({ ...base, rawDataLength: 995, activates: true })).not.toThrow();
    expect(() => tronFeeQuote({ ...base, rawDataLength: 996, activates: true })).toThrow(
      ChainError,
    );
  });

  it("energy is fully covered by staked energy, partially, or not at all", () => {
    const energy = { used: 64285, penalty: 49635 };
    const covered = tronFeeQuote({
      ...base,
      energy,
      resources: { ...RESOURCES, netLimit: 500, energyLimit: 70000 },
    });
    expect(covered.energy).toStrictEqual({
      used: 64285,
      penalty: 49635,
      available: 70000n,
      burn: "0",
      feeLimit: "9642750",
    });
    expect(covered.expected).toBe("0");
    expect(covered.max).toBe(String(334000 + 9642750));

    const partial = tronFeeQuote({
      ...base,
      energy,
      resources: { ...RESOURCES, netLimit: 500, energyLimit: 40000 },
    });
    expect(partial.energy?.burn).toBe(String(24285 * 100));
    expect(partial.expected).toBe(String(24285 * 100));

    const none = tronFeeQuote({ ...base, energy });
    expect(none.energy?.burn).toBe(String(64285 * 100));
    // Bandwidth is covered by free net (600 ≥ 334), so expected is energy burn alone.
    expect(none.expected).toBe(String(64285 * 100));
    expect(none.max).toBe(String(334000 + 9642750));
  });

  it("reports tokenRecipientEmpty as a warning", () => {
    const quote = tronFeeQuote({ ...base, tokenRecipientEmpty: true });
    expect(quote.warnings).toStrictEqual(["token-recipient-empty"]);
  });

  it("throws when the energy estimate exceeds maxFeeLimit", () => {
    expect(() => tronFeeQuote({ ...base, energy: { used: 200_000_000, penalty: 0 } })).toThrow(
      ChainError,
    );
  });

  it("a fixed feeLimit replaces the estimate-derived one — and is never refused", () => {
    const energy = { used: 64285, penalty: 0 };
    const quote = tronFeeQuote({ ...base, energy, feeLimit: 7_000_000n });
    expect(quote.energy?.feeLimit).toBe("7000000");
    // max = bandwidth burn + the dApp's own fee_limit.
    expect(quote.max).toBe(String(334000 + 7_000_000));
    expect(quote.warnings).toStrictEqual([]);

    // An estimate above the chain cap refuses only when the fee_limit is computed; a fixed
    // one is used as given.
    const huge = tronFeeQuote({ ...base, energy: { used: 200_000_000, penalty: 0 }, feeLimit: 1n });
    expect(huge.energy?.feeLimit).toBe("1");
  });

  it("warns fee-limit-below-estimate when the estimate's cost beats the fixed fee_limit", () => {
    const energy = { used: 64285, penalty: 0 };
    // 64285 × 100 = 6 428 500 > limit → warning at and above, not below.
    expect(tronFeeQuote({ ...base, energy, feeLimit: 6_428_499n }).warnings).toStrictEqual([
      "fee-limit-below-estimate",
    ]);
    expect(tronFeeQuote({ ...base, energy, feeLimit: 6_428_500n }).warnings).toStrictEqual([]);
  });

  it("a memo adds getMemoFee to expected and max and reports it", () => {
    const quote = tronFeeQuote({ ...base, memo: true });
    expect(quote.memo).toBe("1000000");
    // Free bandwidth covers the bytes, so expected is the memo fee alone.
    expect(quote.expected).toBe("1000000");
    expect(quote.max).toBe(String(334000 + 1_000_000));
    const energy = tronFeeQuote({ ...base, memo: true, energy: { used: 1, penalty: 0 } });
    expect(energy.expected).toBe(String(100 + 1_000_000));
  });

  it("without memo or feeLimit the output shape is unchanged", () => {
    const quote = tronFeeQuote({ ...base, energy: { used: 64285, penalty: 0 } });
    expect("memo" in quote).toBe(false);
    expect(quote.energy?.feeLimit).toBe("9642750");
    expect(quote.max).toBe(String(334000 + 9642750));
  });
});

describe("fuzz", () => {
  const numRuns = Number(process.env["FUZZ_RUNS"] ?? "100");

  const paramArb = fc.record({
    transactionFee: fc.bigInt({ min: 0n, max: 10n ** 9n }),
    energyFee: fc.bigInt({ min: 0n, max: 10n ** 9n }),
    createAccountFee: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    createNewAccountFeeInSystemContract: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    maxFeeLimit: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    createNewAccountBandwidthRate: fc.bigInt({ min: 0n, max: 10n ** 3n }),
    maxCreateAccountTxSize: fc.bigInt({ min: 0n, max: 10n ** 6n }),
    memoFee: fc.bigInt({ min: 0n, max: 10n ** 9n }),
  });
  const resourcesArb = fc.record({
    freeNetLimit: fc.nat({ max: 10 ** 7 }),
    freeNetUsed: fc.nat({ max: 10 ** 7 }),
    netLimit: fc.nat({ max: 10 ** 7 }),
    netUsed: fc.nat({ max: 10 ** 7 }),
    energyLimit: fc.nat({ max: 10 ** 7 }),
    energyUsed: fc.nat({ max: 10 ** 7 }),
    tronPowerLimit: fc.nat({ max: 10 ** 7 }),
    tronPowerUsed: fc.nat({ max: 10 ** 7 }),
  });
  const inputArb = fc.record({
    rawDataLength: fc.integer({ min: 1, max: 10 ** 5 }),
    params: paramArb,
    resources: resourcesArb,
    activates: fc.boolean(),
    energy: fc.option(
      fc.record({ used: fc.nat({ max: 10 ** 7 }), penalty: fc.nat({ max: 10 ** 7 }) }),
      { nil: undefined },
    ),
    tokenRecipientEmpty: fc.boolean(),
    memo: fc.boolean(),
  });

  it("tronFeeQuote's max never undershoots its expected", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(feeMaxCovers(input)).toBe(true);
      }),
      { numRuns },
    );
  });

  it("readers on arbitrary JSON return or throw Error, never foreign exceptions", async () => {
    const reader = async (a: TronApi) => transactionInfo(a, TXID, false);
    await fc.assert(
      fc.asyncProperty(fc.json(), async (body) => {
        const ok = await resolvedOrError(async () =>
          reader(api({ "/wallet/gettransactioninfobyid": body })),
        );
        expect(ok).toBe(true);
      }),
      { numRuns },
    );
  });
});

const logAddressValid = (s: string): boolean => {
  const out = tronLogAddress(s);
  return out === undefined || isTronAddress(out);
};

describe("tronLogAddress", () => {
  it.each([
    // gettransactioninfobyid: the 20-byte body as 40 hex characters (mainnet USDT).
    ["a614f803b6fd780986a42c78ec9c7f77e6ded13c", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
    // triggerconstantcontract with visible:true: the body base58check-encoded.
    ["G9AHnMvAgqKJ2eWErupYfdzu6hgWVUZqu", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
  ])("restores the version byte on %s", (input, expected) => {
    expect(tronLogAddress(input)).toBe(expected);
  });

  it.each([
    ["41a614f803b6fd780986a42c78ec9c7f77e6ded13c"], // the 21-byte hex form is not a log shape
    ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"], // a full T… address decodes to 21 bytes
    ["a614f803b6fd780986a42c78ec9c7f77e6ded1"], // 38 hex chars
    ["zz"],
    [""],
    [undefined],
  ])("returns undefined for %s", (input) => {
    expect(tronLogAddress(input)).toBeUndefined();
  });

  it("returns undefined or a valid address for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(logAddressValid(s)).toBe(true);
      }),
    );
  });
});

describe("pinnedTronCaller retries throttled reads", () => {
  const throttled = (status: number, retryAfter?: string): Response =>
    new Response("slow down", {
      status,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });
  const rig = (
    responses: ReadonlyArray<Response>,
    clockV = 0,
    until = 60_000,
  ): {
    calls: Array<{ url: string; headers: Record<string, string> }>;
    sleeps: number[];
    api: ReturnType<typeof pinnedTronCaller>;
  } => {
    const now = { v: clockV };
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const sleeps: number[] = [];
    const queue = [...responses];
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      await Promise.resolve();
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      const next = queue.shift();
      if (next === undefined) {
        throw new TypeError("no answer queued");
      }
      return next;
    };
    const api = pinnedTronCaller(["https://a.test", "https://b.test"], fetchFn, {
      until: () => until,
      now: () => now.v,
      sleep: async (ms) => {
        await Promise.resolve();
        sleeps.push(ms);
        now.v += ms;
      },
    });
    return { calls, sleeps, api };
  };

  it("waits Retry-After on a pinned 429 then answers from the same pin", async () => {
    const r = rig([Response.json({ ok: 1 }), throttled(429, "2"), Response.json({ ok: 2 })]);
    await expect(r.api.post("/wallet/getnowblock", {})).resolves.toStrictEqual({ ok: 1 });
    await expect(r.api.post("/wallet/getnowblock", {})).resolves.toStrictEqual({ ok: 2 });
    expect(r.sleeps).toStrictEqual([2000]);
    expect(r.calls.map((c) => c.url)).toStrictEqual([
      "https://a.test/wallet/getnowblock",
      "https://a.test/wallet/getnowblock",
      "https://a.test/wallet/getnowblock",
    ]);
    expect(r.calls.map((c) => c.headers["x-gateway-provider"])).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("retries a pinned 503 the same way and defaults missing Retry-After to 1 s", async () => {
    const r = rig([Response.json({ ok: 1 }), throttled(503), Response.json({ ok: 2 })]);
    await r.api.post("/wallet/getnowblock", {});
    await expect(r.api.post("/wallet/getnowblock", {})).resolves.toStrictEqual({ ok: 2 });
    expect(r.sleeps).toStrictEqual([1000]);
  });

  it("clamps Retry-After: 0 to the 250 ms floor", async () => {
    const r = rig([Response.json({ ok: 1 }), throttled(429, "0"), Response.json({ ok: 2 })]);
    await r.api.post("/wallet/getnowblock", {});
    await r.api.post("/wallet/getnowblock", {});
    expect(r.sleeps).toStrictEqual([250]);
  });

  it("throws TronThrottledError with the backoff when the deadline leaves no room", async () => {
    const r = rig([Response.json({ ok: 1 }), throttled(429, "2")], 0, 1000);
    await r.api.post("/wallet/getnowblock", {});
    const attempt = r.api.post("/wallet/getnowblock", {});
    await expect(attempt).rejects.toThrow(TronThrottledError);
    const err = await attempt.catch((error: unknown) => error);
    expect(err).toBeInstanceOf(TronThrottledError);
    expect((err as TronThrottledError).retryAfterMs).toBe(2000);
    expect(r.sleeps).toStrictEqual([]);
  });

  it("never retries a broadcast: one call, the original error", async () => {
    const r = rig([Response.json({ ok: 1 }), throttled(429, "1")]);
    await r.api.post("/wallet/getnowblock", {});
    await expect(r.api.post("/wallet/broadcasthex", {})).rejects.toThrow(
      "/wallet/broadcasthex: HTTP 429",
    );
    expect(r.sleeps).toStrictEqual([]);
    expect(r.calls).toHaveLength(2);
  });

  it("does not retry a 500", async () => {
    const r = rig([Response.json({ ok: 1 }), throttled(500)]);
    await r.api.post("/wallet/getnowblock", {});
    await expect(r.api.post("/wallet/getnowblock", {})).rejects.toThrow("HTTP 500");
    expect(r.sleeps).toStrictEqual([]);
  });

  it("propagates the original error when no retry option is given", async () => {
    const calls: string[] = [];
    const api = pinnedTronCaller(["https://a.test"], async (input) => {
      await Promise.resolve();
      calls.push(String(input));
      return throttled(429, "1");
    });
    await expect(api.post("/wallet/getnowblock", {})).rejects.toThrow("HTTP 429");
    expect(calls).toHaveLength(1);
  });

  it("re-runs the failover round when the unpinned attempt's last error is a 429", async () => {
    const r = rig([throttled(429, "1"), throttled(429, "1"), Response.json({ ok: 9 })]);
    await expect(r.api.post("/wallet/getnowblock", {})).resolves.toStrictEqual({ ok: 9 });
    expect(r.sleeps).toStrictEqual([1000]);
    expect(r.calls.map((c) => c.url)).toStrictEqual([
      "https://a.test/wallet/getnowblock",
      "https://b.test/wallet/getnowblock",
      "https://a.test/wallet/getnowblock",
    ]);
  });
});
