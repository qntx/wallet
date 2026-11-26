import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { OutScript } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import type { IntentWarning, IntentWarningKind, SignRequest } from "@qntx/wallet-chains";
import { EMPTY_BITCOIN_OWN } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm } from "@qntx/wallet-chains/evm";

import {
  AcknowledgementRequiredError,
  RESIMULATE_AFTER_MS,
  RequestController,
  SimulationChangedError,
  requiredAcknowledgement,
} from "../src/requests/controller.ts";
import type { PendingRequest } from "../src/requests/controller.ts";
import { WARNING_RISK, assessWarnings } from "../src/requests/risk.ts";
import type { SimulationOutcome } from "../src/requests/simulation.ts";
import type { BitcoinPsbtInput, PreparedBitcoinPsbt } from "../src/requests/types.ts";
import type { SparkController } from "../src/spark/controller.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type {
  DisplayIntent,
  PreparedRequest,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import { bookDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

/**
 * The chain decoder's `IntentWarning`s become engine `RiskFinding`s at one prepare choke point —
 * every origin (internal, browser, WalletConnect, app) merges them into `PendingRequest.risk`, and
 * the approval-time re-simulation refresh keeps them. `WARNING_RISK` is asserted exhaustive against
 * the `IntentWarningKind` union parsed out of @qntx/wallet-chains source, and the mapping is
 * replayed over every Fiat24 decode vector in vectors/chains/.
 */
const ARB = "eip155:42161";
const BITCOIN_NET = "bip122:000000000019d6689c085ae165831e93";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const BTC_GROUP = { walletId: "w", groupIndex: 0 };
const BTC_ACCOUNT_REF = { ...ACCOUNT, template: "btc.bip84" as const };
const BTC_DEST = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ORIGIN = { kind: "browser" as const, origin: "https://dapp.example" };
const VERIFY = { kind: "password" as const, password: "pw" };
const USD24 = "0xbe00f3db78688d9704bcb4e0a827aea3a9cc0d62";
const CARD = "0xe2e3b88b9893e18d0867c08f9ca93f8ab5935b14";

/* vectors/chains/fiat24.json — oracle cases with hand-written expected warnings (the chains
   package asserts the same expectations). */
type VectorCase = {
  readonly name: string;
  readonly signer: string;
  readonly request: SignRequest & { readonly message?: { readonly $bytes: string } };
  readonly expect: { readonly warnings: ReadonlyArray<string> };
};

/** `$bytes` hex fields materialize — the shape the pipeline hands the decoder. */
const vectorRequest = (v: VectorCase): SignRequest => {
  if (v.request.kind === "evm.personal-message") {
    return {
      ...v.request,
      message: hexToBytes(v.request.message?.$bytes?.replace(/^0x/, "") ?? ""),
    };
  }
  return v.request;
};

const fiat24Vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/fiat24.json"), "utf8"),
) as { cases: ReadonlyArray<VectorCase> };

/* vectors/chains/fiat24-mainnet.json — raw Arbitrum One calls into the pinned proxies. */
type CorpusTx = {
  readonly hash: string;
  readonly chainId: string;
  readonly type: string;
  readonly from: string;
  readonly to: string | null;
  readonly value: string;
  readonly nonce: string;
  readonly gas: string;
  readonly gasPrice: string | null;
  readonly maxFeePerGas: string | null;
  readonly maxPriorityFeePerGas: string | null;
  readonly input: string;
};

const corpus = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/fiat24-mainnet.json"), "utf8"),
) as { cases: ReadonlyArray<CorpusTx> };

const corpusRequest = (c: CorpusTx): SignRequest => {
  const base = {
    chainId: Number(c.chainId),
    nonce: Number(c.nonce),
    gas: c.gas,
    value: c.value,
    data: c.input,
    ...(c.to === null ? {} : { to: c.to }),
  };
  return {
    kind: "evm.transaction",
    network: `eip155:${base.chainId}`,
    account: ACCOUNT,
    tx:
      c.type === "0x2"
        ? {
            ...base,
            type: "eip1559",
            accessList: [],
            maxFeePerGas: c.maxFeePerGas ?? "0x0",
            maxPriorityFeePerGas: c.maxPriorityFeePerGas ?? "0x0",
          }
        : { ...base, type: "legacy", gasPrice: c.gasPrice ?? "0x0" },
  };
};

const vector = (name: string): VectorCase => {
  const found = fiat24Vectors.cases.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`fiat24 vector ${name} missing`);
  }
  return found;
};

/** The `IntentWarningKind` member names, parsed out of the chains source — not the type system. */
const intentWarningKinds = (): ReadonlyArray<string> => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../wallet-chains/src/index.ts"),
    "utf8",
  );
  const union = /export type IntentWarningKind =([^;]+);/.exec(source);
  if (union === null || union[1] === undefined) {
    throw new Error("IntentWarningKind union not found in wallet-chains index.ts");
  }
  return [...union[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
};

const warn = (kind: IntentWarningKind, level?: "danger"): IntentWarning => ({
  kind,
  message: `w:${kind}`,
  ...(level === undefined ? {} : { level }),
});

describe("WARNING_RISK", () => {
  it("covers every IntentWarningKind exactly", () => {
    expect([...intentWarningKinds()].toSorted()).toStrictEqual(
      Object.keys(WARNING_RISK).toSorted(),
    );
  });

  it("maps exactly the seven fiat24 kinds plus the own-output kinds", () => {
    const danger = ["fiat24-unlimited-approval", "fiat24-account-move"];
    const warning = [
      "fiat24-internal-account",
      "fiat24-card-pull",
      "fiat24-exact-out-unbounded",
      "fiat24-payee-offchain",
      "fiat24-account-burn",
    ];
    for (const kind of danger) {
      expect(WARNING_RISK[kind as IntentWarningKind]).toStrictEqual({
        code: kind,
        level: "danger",
      });
    }
    for (const kind of warning) {
      expect(WARNING_RISK[kind as IntentWarningKind]).toStrictEqual({
        code: kind,
        level: "warning",
      });
    }
    // An own-key output the wallet does not discover is a finding — the funds may never show.
    expect(WARNING_RISK["unusual-own-output"]).toStrictEqual({
      code: "bitcoin-unusual-output",
      level: "warning",
    });
    // An output a never-confirmed entry serves may pay a key the device does not hold.
    expect(WARNING_RISK["unconfirmed-signer-output"]).toStrictEqual({
      code: "bitcoin-unconfirmed-output",
      level: "danger",
    });
    const mapped = Object.entries(WARNING_RISK)
      .filter(([, entry]) => entry !== undefined)
      .map(([kind]) => kind)
      .toSorted();
    expect(mapped).toStrictEqual(
      [...danger, ...warning, "unusual-own-output", "unconfirmed-signer-output"].toSorted(),
    );
  });

  it("leaves sighash-single-anyonecanpay unmapped — assessBitcoinPsbts already covers it", () => {
    expect(WARNING_RISK["sighash-single-anyonecanpay"]).toBeUndefined();
  });
});

describe("assessWarnings", () => {
  it("maps warnings through the table and skips unmapped kinds", () => {
    expect(
      assessWarnings([{ warnings: [warn("fiat24-payee-offchain"), warn("fiat24-issuer-rate")] }]),
    ).toStrictEqual([{ code: "fiat24-payee-offchain", level: "warning" }]);
  });

  it("escalates a warning stamped level danger over the table default", () => {
    expect(assessWarnings([{ warnings: [warn("fiat24-card-pull", "danger")] }])).toStrictEqual([
      { code: "fiat24-card-pull", level: "danger" },
    ]);
  });

  it("deduplicates across intents and never downgrades a danger copy", () => {
    expect(
      assessWarnings([
        { warnings: [warn("fiat24-payee-offchain"), warn("fiat24-account-burn")] },
        { warnings: [warn("fiat24-payee-offchain")] },
      ]),
    ).toStrictEqual([
      { code: "fiat24-payee-offchain", level: "warning" },
      { code: "fiat24-account-burn", level: "warning" },
    ]);
    expect(
      assessWarnings([
        { warnings: [warn("fiat24-card-pull", "danger"), warn("fiat24-card-pull")] },
      ]),
    ).toStrictEqual([{ code: "fiat24-card-pull", level: "danger" }]);
    expect(
      assessWarnings([
        { warnings: [warn("fiat24-card-pull"), warn("fiat24-card-pull", "danger")] },
      ]),
    ).toStrictEqual([{ code: "fiat24-card-pull", level: "danger" }]);
  });

  it("orders danger findings before warning findings", () => {
    expect(
      assessWarnings([{ warnings: [warn("fiat24-payee-offchain"), warn("fiat24-account-move")] }]),
    ).toStrictEqual([
      { code: "fiat24-account-move", level: "danger" },
      { code: "fiat24-payee-offchain", level: "warning" },
    ]);
  });
});

/* Every decoded warning must map (or be intentionally prompt-only); a decoder danger-stamp on a
   kind without a risk mapping is a table gap — fail loud. */
const expectWarningsMapped = (intent: DisplayIntent): void => {
  const findings = assessWarnings([intent]);
  for (const warning of intent.warnings) {
    const entry = WARNING_RISK[warning.kind];
    if (warning.level === "danger") {
      expect(entry, `danger warning ${warning.kind} has no risk mapping`).toBeDefined();
    }
    if (entry !== undefined) {
      expect(findings).toContainEqual({
        code: entry.code,
        level: warning.level ?? entry.level,
      });
    }
  }
  expect(new Set(findings.map((f) => f.code)).size).toBe(findings.length);
  const firstWarning = findings.findIndex((f) => f.level === "warning");
  if (firstWarning !== -1) {
    for (const [index, finding] of findings.entries()) {
      if (index > firstWarning) {
        expect(finding.level).toBe("warning");
      }
    }
  }
};

describe("fiat24 decode vectors", () => {
  it.each(fiat24Vectors.cases)("fiat24.json $name", (v) => {
    const intent = decodeEvm(vectorRequest(v), v.signer);
    expect(intent.warnings.map((w) => w.kind)).toStrictEqual(v.expect.warnings);
    expectWarningsMapped(intent);
  });

  it.each(corpus.cases.map((c) => [c.hash.slice(0, 10), c] as const))(
    "fiat24-mainnet.json %s",
    (_hash, c) => {
      const intent = decodeEvm(corpusRequest(c), c.from);
      expect(intent.family).toBe("evm");
      expectWarningsMapped(intent);
    },
  );
});

const tracked = (id: string): TrackedTransaction => ({
  id,
  family: "evm",
  network: ARB,
  account: "w",
  hash: "0x1",
  state: "submitted",
  intent: undefined,
  nonce: 0,
  submittedAt: 0,
  error: undefined,
});

const succeed = (amount: string): SimulationOutcome => ({
  status: "success",
  changes: [{ asset: "native", amount, verified: true }],
});

const prepared = (
  requestId: string,
  intent: DisplayIntent,
  signer: string,
  sim?: { first: SimulationOutcome; queue: SimulationOutcome[] },
): PreparedRequest => ({
  txId: `tx-${requestId}`,
  account: ACCOUNT,
  network: ARB,
  intent,
  checks: [],
  signer,
  ...(sim === undefined
    ? {}
    : {
        simulation: sim.first,
        resimulate: async () => Promise.resolve(sim.queue.shift() ?? sim.first),
      }),
  staleReason: () => undefined,
  submit: async () => Promise.resolve(tracked(`tx-${requestId}`)),
  release: () => undefined,
});

/** The warnings a display still shows the prompt — mirrors the controller's intent extraction. */
const displayWarnings = (display: PendingRequest["display"]): ReadonlyArray<IntentWarning> => {
  if ("warnings" in display) {
    return display.warnings;
  }
  if (display.kind === "solana.sign") {
    return display.transactions.flatMap((i) => i.warnings);
  }
  if (display.kind === "bitcoin.sign") {
    return (display.psbts ?? []).flatMap((i) => i.warnings);
  }
  return [];
};

/** A request controller whose transaction layer returns builds carrying real decoded intents. */
const rig = (
  build: (requestId: string) => PreparedRequest,
  over: {
    bitcoinPrepare?: (
      account: unknown,
      network: unknown,
      psbts: ReadonlyArray<BitcoinPsbtInput>,
    ) => Promise<ReadonlyArray<PreparedBitcoinPsbt>>;
  } = {},
) => {
  let now = 1000;
  const transactions = {
    getState: () => ({ txs: {} }),
    bindDappSolana: async () => Promise.resolve([]),
    prepareDapp: async () => Promise.resolve(build("dapp")),
    prepareEvmInternal: async (_input: unknown, requestId: string) =>
      Promise.resolve(build(requestId)),
    prepareSend: async () => Promise.reject(new Error("send not wired")),
  } as unknown as TransactionController;
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    tokens: tokensStub,
    simulateSolana: simulateSolanaStub,
    transactions,
    ...bookDeps(),
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare:
      over.bitcoinPrepare ?? (async () => Promise.reject(new Error("bitcoin not wired"))),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(1),
    now: () => now,
    setTimer: () => () => undefined,
    logger: { warn: () => undefined },
  });
  return {
    requests,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe("warning findings on PendingRequest.risk", () => {
  it("internal: an evm-approve of an unlimited allowance to the Fiat24 card contract", async () => {
    const v = vector("approve-card-unlimited");
    const intent = decodeEvm(vectorRequest(v), v.signer);
    expect(intent.warnings.map((w) => w.kind)).toStrictEqual([
      "fiat24-card-pull",
      "fiat24-unlimited-approval",
    ]);
    const { requests } = rig((id) => prepared(id, intent, v.signer));
    await requests.init();
    const request = await requests.prepare({
      method: "evm-approve",
      account: ACCOUNT,
      network: ARB,
      token: USD24,
      spender: CARD,
      amount: 2n ** 256n - 1n,
      fee: "normal",
    });
    expect(request.origin).toStrictEqual({ kind: "internal" });
    expect(request.risk).toContainEqual({ code: "fiat24-card-pull", level: "warning" });
    expect(request.risk).toContainEqual({
      code: "fiat24-unlimited-approval",
      level: "danger",
    });
    expect(requiredAcknowledgement(request).risk).toContain("fiat24-unlimited-approval");
  });

  it("browser dApp: evm-sign of a Fiat24 account-NFT move needs danger acknowledgement", async () => {
    const v = vector("accountSafeTransferFrom");
    const { requests } = rig((id) => prepared(id, decodeEvm(vectorRequest(v), v.signer), v.signer));
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: ORIGIN,
      account: ACCOUNT,
      network: ARB,
      request: vectorRequest(v),
    });
    expect(request.origin).toStrictEqual(ORIGIN);
    expect(request.risk).toContainEqual({ code: "fiat24-account-move", level: "danger" });
    await expect(
      requests.approve(request.id, "evm-sign", { verify: VERIFY }),
    ).rejects.toBeInstanceOf(AcknowledgementRequiredError);
    await requests.approve(request.id, "evm-sign", approval(request, VERIFY));
    expect(requests.getState().requests[request.id]?.stage).toBe("submitted");
  });

  it("walletconnect: the same decoded warnings reach a peer-originated request", async () => {
    const v = vector("transferByAccountId-eur24-internal");
    const { requests } = rig((id) => prepared(id, decodeEvm(vectorRequest(v), v.signer), v.signer));
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: {
        kind: "walletconnect",
        origin: "walletconnect:t1",
        topic: "t1",
        url: "https://peer.example",
        name: "Peer",
        verify: { validation: "VALID", isScam: false },
      },
      account: ACCOUNT,
      network: ARB,
      request: vectorRequest(v),
    });
    expect(request.origin.kind).toBe("walletconnect");
    expect(request.risk).toContainEqual({ code: "fiat24-internal-account", level: "warning" });
    // warning-level findings alone demand no risk acknowledgement
    expect(requiredAcknowledgement(request).risk).toStrictEqual([]);
  });

  it("app: a fiat24-origin request for a bank payout carries the payee finding", async () => {
    const v = vector("clientPayout");
    const { requests } = rig((id) => prepared(id, decodeEvm(vectorRequest(v), v.signer), v.signer));
    await requests.init();
    const request = await requests.prepare(
      { method: "evm-sign", account: ACCOUNT, network: ARB, request: vectorRequest(v) },
      { kind: "app", id: "fiat24" },
    );
    expect(request.origin).toStrictEqual({ kind: "app", id: "fiat24" });
    expect(request.risk).toContainEqual({ code: "fiat24-payee-offchain", level: "warning" });
    expect(requiredAcknowledgement(request).risk).toStrictEqual([]);
  });

  it("bitcoin-sign: sighash-single-anyonecanpay stays prompt-only, bitcoin-sighash-single covers it", async () => {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addInput({
      txid: "00".repeat(32),
      index: 0,
      sighashType: 0x83,
      witnessUtxo: {
        script: OutScript.encode({ type: "wpkh", hash: new Uint8Array(20).fill(1) }),
        amount: 10_000n,
      },
    });
    tx.addOutputAddress(BTC_DEST, 1000n);
    const psbt = tx.toPSBT(0);
    const { requests } = rig(
      () => {
        throw new Error("no evm build wired in this test");
      },
      {
        bitcoinPrepare: async (_account, _network, psbts) =>
          Promise.resolve(
            psbts.map((input): PreparedBitcoinPsbt => ({
              request: {
                kind: "bitcoin.psbt",
                origin: "internal",
                network: BITCOIN_NET,
                account: BTC_ACCOUNT_REF,
                psbt: input.psbt,
                sign: input.sign,
              },
              own: EMPTY_BITCOIN_OWN,
              inputs: input.sign.map((s) => ({
                index: s.index,
                value: 10_000,
                sigHash: s.sigHash,
                template: s.template,
                frozen: false,
              })),
            })),
          ),
      },
    );
    await requests.init();
    const request = await requests.prepare({
      method: "bitcoin-sign",
      origin: ORIGIN,
      account: BTC_GROUP,
      network: BITCOIN_NET,
      request: {
        kind: "psbt",
        psbts: [
          {
            psbt,
            sign: [{ index: 0, sigHash: "SINGLE|ANYONECANPAY", template: "btc.bip84" }],
          },
        ],
        send: false,
      },
    });
    // The PSBT assessor's danger finding is there; the prompt warning adds no duplicate.
    expect(request.risk).toContainEqual({ code: "bitcoin-sighash-single", level: "danger" });
    expect(request.risk.map((f) => f.code)).not.toContain("sighash-single-anyonecanpay");
    expect(displayWarnings(request.display).map((w) => w.kind)).toStrictEqual([
      "sighash-single-anyonecanpay",
    ]);
  });
});

describe("warning findings survive the approval-time re-simulation", () => {
  it("a changed re-simulation refreshes risk but keeps the decoder findings", async () => {
    const v = vector("clientPayout");
    const { requests, advance } = rig((id) =>
      prepared(id, decodeEvm(vectorRequest(v), v.signer), v.signer, {
        first: succeed("-100"),
        queue: [succeed("-1000")],
      }),
    );
    await requests.init();
    const request = await requests.prepare({
      method: "evm-sign",
      origin: ORIGIN,
      account: ACCOUNT,
      network: ARB,
      request: vectorRequest(v),
    });
    expect(request.risk).toContainEqual({ code: "fiat24-payee-offchain", level: "warning" });
    advance(RESIMULATE_AFTER_MS);
    await expect(
      requests.approve(request.id, "evm-sign", approval(request, VERIFY)),
    ).rejects.toBeInstanceOf(SimulationChangedError);
    const pending = requests.getState().requests[request.id];
    expect(pending?.risk).toContainEqual({ code: "fiat24-payee-offchain", level: "warning" });
    expect(pending?.risk).toContainEqual({ code: "simulation-mismatch", level: "danger" });
    await requests.approve(request.id, "evm-sign", approval(pending, VERIFY));
    expect(requests.getState().requests[request.id]?.stage).toBe("submitted");
  });
});
