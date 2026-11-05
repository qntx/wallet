import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import { encodeSparkAddress } from "@qntx/spark";
import type { SignRequest } from "@qntx/wallet-chains";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { AddressBookController } from "../src/addresses/controller.ts";
import { REQUEST_TTL_MS, RequestController } from "../src/requests/controller.ts";
import { SIGN_LOG_LIMIT, createSignLog } from "../src/requests/sign-log.ts";
import type { SignLogEntry } from "../src/requests/sign-log.ts";
import type { SimulationOutcome } from "../src/requests/simulation.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type {
  DisplayIntent,
  PreparedRequest,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const SEPOLIA = "eip155:11155111";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const VERIFY = { kind: "password", password: "pw" } as const;
const KNOWN = "0x52908400098527886E0F7030069857D2E4169EE7";
const LOOKALIKE = "0x5290aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9EE7";
const OTHER = "0x1111111111111111111111111111111111112222";
const SPARK_REF: SparkAccountRef = { walletId: "w", groupIndex: 0, network: "regtest" };
const SPARK_KEY = secp256k1.getPublicKey(new Uint8Array(32).fill(9), true);
const SPARK_ADDRESS = encodeSparkAddress({ network: "regtest", identityPublicKey: SPARK_KEY });
const OTHER_SPARK = encodeSparkAddress({
  network: "regtest",
  identityPublicKey: secp256k1.getPublicKey(new Uint8Array(32).fill(11), true),
});

const intentTo = (to: string): DisplayIntent =>
  ({
    family: "evm",
    network: SEPOLIA,
    summary: "transfer",
    outflows: [{ to, amount: { asset: "native", amount: "1", decimals: 18 }, verified: true }],
    approvals: [],
    fee: undefined,
    warnings: [],
    verifiability: "full",
  }) as unknown as DisplayIntent;

const trackedTo = (
  to: string,
  state: TrackedTransaction["state"],
  id: string,
): TrackedTransaction => ({
  id,
  family: "evm",
  network: SEPOLIA,
  account: "w",
  hash: "0x1",
  state,
  intent: intentTo(to),
  nonce: 0,
  submittedAt: 0,
  error: undefined,
});

function world() {
  const txs: Record<string, TrackedTransaction> = {};
  const events: string[] = [];
  const state = {
    recipient: OTHER,
    stale: undefined as string | undefined,
    submitFails: undefined as Error | undefined,
    simulation: undefined as SimulationOutcome | undefined,
    gate: undefined as Promise<void> | undefined,
  };
  let counter = 0;
  const transactions = {
    getState: () => ({ txs }),
    prepareSend: async (_p: unknown, requestId: string): Promise<PreparedRequest> =>
      Promise.resolve({
        txId: `tx-${requestId}`,
        account: ACCOUNT,
        network: SEPOLIA,
        intent: intentTo(state.recipient),
        checks: [],
        ...(state.simulation === undefined ? {} : { simulation: state.simulation }),
        staleReason: () => state.stale,
        submit: async () => {
          await state.gate;
          if (state.submitFails !== undefined) {
            throw state.submitFails;
          }
          return { ...trackedTo(state.recipient, "submitted", `tx-${requestId}`) };
        },
        release: () => {
          events.push(`release ${requestId}`);
        },
      }),
    prepareDapp: async (account: unknown, request: unknown) => {
      const normalized = normalizeEvm(request);
      return Promise.resolve({
        account,
        network: normalized.network,
        signer: OTHER,
        intent: decodeEvm(normalized),
        checks: [],
        staleReason: () => undefined,
        release: () => {
          events.push("release dapp");
        },
        submit: async () => Promise.resolve({ kind: normalized.kind, signature: "0x1234" }),
      });
    },
  } as unknown as TransactionController;
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const openStore = async () => Promise.resolve(createMemoryEngineStore(backing));
  const warnings: string[] = [];
  const logger = { warn: (m: string) => warnings.push(m) };
  const nextCounter = (): number => {
    counter += 1;
    return counter;
  };
  const addressBook = new AddressBookController({
    openStore,
    random: (n) => new Uint8Array(n).fill(nextCounter()),
    now: () => 0,
    logger,
  });
  let now = 1000;
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("nostr-sign is not wired in this test")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => {
      await Promise.resolve();
      throw new Error("solana-sign is not wired in this test");
    },
    addressBook,
    openStore,
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(nextCounter()),
    now: () => now,
    setTimer: () => () => undefined,
    logger,
  });
  const start = async () => {
    await addressBook.init();
    await requests.init();
  };
  return {
    requests,
    addressBook,
    txs,
    state,
    warnings,
    start,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const send = (to = OTHER) => ({
  method: "send" as const,
  account: ACCOUNT,
  network: SEPOLIA,
  to,
  amount: 1n,
  fee: "normal" as const,
});

describe("recipient risk", () => {
  it("a first-time recipient is a warning", async () => {
    const w = world();
    await w.start();
    const request = await w.requests.prepare(send());
    expect(request.risk).toStrictEqual([{ code: "first-recipient", level: "warning" }]);
  });

  it("an address-book contact carries no risk, in any case", async () => {
    const w = world();
    await w.start();
    await w.addressBook.add({ name: "Alice", family: "evm", address: KNOWN });
    w.state.recipient = KNOWN.toLowerCase();
    const request = await w.requests.prepare(send());
    expect(request.risk).toStrictEqual([]);
  });

  it("a tracked recipient carries no risk; a failed one does not count", async () => {
    const w = world();
    await w.start();
    w.txs["a"] = trackedTo(OTHER, "confirmed", "a");
    w.txs["b"] = trackedTo(KNOWN, "failed", "b");
    const known = await w.requests.prepare(send());
    expect(known.risk).toStrictEqual([]);
    w.state.recipient = KNOWN;
    const unknown = await w.requests.prepare(send(KNOWN));
    expect(unknown.risk).toStrictEqual([{ code: "first-recipient", level: "warning" }]);
  });

  it("a lookalike of a known address is poisoning, danger first", async () => {
    const w = world();
    await w.start();
    await w.addressBook.add({ name: "Alice", family: "evm", address: KNOWN });
    w.state.recipient = LOOKALIKE;
    const request = await w.requests.prepare(send(LOOKALIKE));
    expect(request.risk).toStrictEqual([
      { code: "address-poisoning", level: "danger" },
      { code: "first-recipient", level: "warning" },
    ]);
    expect(request.verification).toBe("verified");
  });

  it("a Spark transfer checks its receiver against Spark contacts", async () => {
    const w = world();
    await w.start();
    await w.addressBook.add({ name: "Bob", family: "spark", address: SPARK_ADDRESS });
    const pay = async (address: string) =>
      w.requests.prepare({
        method: "pay",
        account: SPARK_REF,
        option: { kind: "spark", address },
        amountSats: 5,
      });
    const known = await pay(SPARK_ADDRESS);
    const unknown = await pay(OTHER_SPARK);
    expect(known.risk).toStrictEqual([]);
    expect(unknown.risk).toStrictEqual([{ code: "first-recipient", level: "warning" }]);
  });

  it("Lightning and cooperative exits are not assessed", async () => {
    const w = world();
    await w.start();
    const exit = await w.requests.prepare({
      method: "pay",
      account: SPARK_REF,
      option: { kind: "bitcoin", address: "bcrt1pexample" },
      amountSats: 1000,
    });
    expect(exit.risk).toStrictEqual([]);
  });
});

describe("simulation", () => {
  const NATIVE_OUT = (amount: string): SimulationOutcome => ({
    status: "success",
    changes: [{ asset: "native", amount, verified: true }],
  });

  it("a request without a simulation has none and keeps its checks", async () => {
    const w = world();
    await w.start();
    const request = await w.requests.prepare(send());
    expect(request.simulation).toBeUndefined();
    expect(request.checks).toStrictEqual([]);
  });

  it("an unavailable simulation makes the request unverifiable", async () => {
    const w = world();
    w.state.simulation = { status: "unavailable", error: "timeout" };
    await w.start();
    const request = await w.requests.prepare(send());
    expect(request.checks).toStrictEqual(["simulation-unavailable"]);
    expect(request.verification).toBe("unverifiable");
    expect(request.simulation).toStrictEqual({ status: "unavailable", error: "timeout" });
  });

  it("a revert is a danger, ahead of the first-recipient warning", async () => {
    const w = world();
    w.state.simulation = { status: "reverted", error: "execution reverted" };
    await w.start();
    const request = await w.requests.prepare(send());
    expect(request.risk).toStrictEqual([
      { code: "simulation-reverted", level: "danger" },
      { code: "first-recipient", level: "warning" },
    ]);
    expect(request.verification).toBe("verified");
  });

  it("an outflow above the declared one is a mismatch danger", async () => {
    const w = world();
    w.state.simulation = NATIVE_OUT("-2");
    await w.start();
    const request = await w.requests.prepare(send());
    expect(request.risk).toContainEqual({ code: "simulation-mismatch", level: "danger" });
  });

  it("an outflow equal to the declared one adds nothing", async () => {
    const w = world();
    w.state.simulation = NATIVE_OUT("-1");
    await w.start();
    const request = await w.requests.prepare(send());
    expect(request.risk.map((r) => r.code)).toStrictEqual(["first-recipient"]);
    expect(request.simulation).toStrictEqual(NATIVE_OUT("-1"));
  });
});

describe("signature record", () => {
  it("writes one entry per final stage without signature bytes", async () => {
    const w = world();
    await w.start();
    const submitted = await w.requests.prepare(send());
    await w.requests.approve(submitted.id, "send", VERIFY);

    const rejected = await w.requests.prepare(send());
    w.requests.reject(rejected.id);

    const failed = await w.requests.prepare(send());
    w.state.stale = "nonce taken";
    await expect(w.requests.approve(failed.id, "send", VERIFY)).rejects.toThrow("nonce taken");
    w.state.stale = undefined;

    const expired = await w.requests.prepare(send());
    w.advance(REQUEST_TTL_MS);
    await expect(w.requests.approve(expired.id, "send", VERIFY)).rejects.toThrow("expired");

    const invalidated = await w.requests.prepare(send());
    w.requests.lock();
    await w.requests.init();

    const log = await w.requests.signLog();
    const byId = new Map(log.map((e) => [e.id, e]));
    expect(log).toHaveLength(5);
    expect(byId.get(submitted.id)).toMatchObject({
      outcome: "submitted",
      method: "send",
      network: SEPOLIA,
      summary: "transfer",
      verification: "verified",
      checks: [],
      origin: { kind: "internal" },
    });
    expect(byId.get(rejected.id)?.outcome).toBe("rejected");
    expect(byId.get(failed.id)).toMatchObject({ outcome: "failed", error: "nonce taken" });
    expect(byId.get(expired.id)?.outcome).toBe("expired");
    expect(byId.get(invalidated.id)?.outcome).toBe("invalidated");
    expect(byId.get(submitted.id)?.risk).toStrictEqual([
      { code: "first-recipient", level: "warning" },
    ]);
    const serialized = JSON.stringify(log);
    for (const forbidden of ["signature", "signedTransaction", "psbt", "message"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("lists newest first and clear empties it", async () => {
    const w = world();
    await w.start();
    const first = await w.requests.prepare(send());
    w.requests.reject(first.id);
    w.advance(10);
    const second = await w.requests.prepare(send());
    w.requests.reject(second.id);
    const log = await w.requests.signLog();
    expect(log.map((e) => e.id)).toStrictEqual([second.id, first.id]);
    await w.requests.clearSignLog();
    await expect(w.requests.signLog()).resolves.toStrictEqual([]);
  });

  it("skips malformed entries read back from the store", async () => {
    const store = createMemoryEngineStore();
    const log = createSignLog({ warn: () => undefined });
    log.open(store);
    const good: SignLogEntry = {
      id: "req-good",
      at: 2,
      origin: { kind: "internal" },
      method: "pay",
      account: SPARK_REF,
      network: "regtest",
      summary: "transfer 5",
      verification: "verified",
      checks: [],
      risk: [],
      outcome: "submitted",
    };
    await log.append(good);
    const put = async (key: string, value: unknown) =>
      store.collection("sign-log").put(key, new TextEncoder().encode(JSON.stringify(value)));
    await put("0000000000000001-bad-method", { ...good, id: "bad-method", at: 1, method: "swap" });
    await put("0000000000000003-bad-account", {
      ...good,
      id: "bad-account",
      at: 3,
      account: { kind: "hd" },
    });
    await put("0000000000000004-bad-outcome", { ...good, id: "bad-outcome", at: 4, outcome: "ok" });
    await put("0000000000000005-junk", "not an entry");
    await put("0000000000000006-bad-origin", {
      ...good,
      id: "bad-origin",
      at: 6,
      origin: { kind: "browser" },
    });
    const entries = await log.list();
    expect(entries.map((e) => e.id)).toStrictEqual(["req-good"]);
  });

  it("reads back solana-sign and bitcoin-sign entries", async () => {
    const log = createSignLog({ warn: () => undefined });
    log.open(createMemoryEngineStore());
    const base: SignLogEntry = {
      id: "req-sol",
      at: 1,
      origin: { kind: "browser", origin: "https://app.example" },
      method: "solana-sign",
      account: { walletId: "w", groupIndex: 0, address: "SoLaNa" },
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      summary: "solana message",
      verification: "verified",
      checks: [],
      risk: [],
      outcome: "submitted",
    };
    await log.append(base);
    await log.append({
      ...base,
      id: "req-btc",
      at: 2,
      method: "bitcoin-sign",
      account: { walletId: "w", groupIndex: 0, address: "bc1q", template: "btc.bip84" },
      network: "bip122:000000000019d6689c085ae165831e93",
      summary: "bitcoin message",
    });
    const entries = await log.list();
    expect(entries.map((e) => [e.id, e.method])).toStrictEqual([
      ["req-btc", "bitcoin-sign"],
      ["req-sol", "solana-sign"],
    ]);
  });

  it("keeps only the newest 1000 entries", async () => {
    const warnings: string[] = [];
    const log = createSignLog({ warn: (m) => warnings.push(m) });
    log.open(createMemoryEngineStore());
    const entry = (i: number): SignLogEntry => ({
      id: `req-${i}`,
      at: i,
      origin: { kind: "internal" },
      method: "send",
      account: ACCOUNT,
      network: SEPOLIA,
      summary: "transfer",
      verification: "verified",
      checks: [],
      risk: [],
      outcome: "rejected",
    });
    for (let i = 0; i < SIGN_LOG_LIMIT + 5; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- appends are ordered
      await log.append(entry(i));
    }
    const kept = await log.list();
    expect(kept).toHaveLength(SIGN_LOG_LIMIT);
    expect(kept[0]?.id).toBe(`req-${SIGN_LOG_LIMIT + 4}`);
    expect(kept.at(-1)?.id).toBe("req-5");
  });

  it("a final stage that arrives after the lock is warned about, not written", async () => {
    const w = world();
    await w.start();
    const request = await w.requests.prepare(send());
    let release: () => void = () => undefined;
    w.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const approving = w.requests.approve(request.id, "send", VERIFY);
    await Promise.resolve();
    w.requests.lock();
    release();
    await approving;
    await new Promise((resolve) => {
      setTimeout(resolve);
    });
    expect(w.warnings.some((m) => m.includes("not written: vault locked"))).toBe(true);
  });
});

const evmSign = (request: SignRequest) => ({
  method: "evm-sign" as const,
  origin: { kind: "browser" as const, origin: "https://app.example" },
  account: ACCOUNT,
  network: SEPOLIA,
  request,
});

const itemField =
  "uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount";
const typedFields = (spec: string) =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

const SEAPORT_TYPES = {
  OrderComponents: typedFields(
    "address offerer, address zone, OfferItem[] offer, ConsiderationItem[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter",
  ),
  OfferItem: typedFields(itemField),
  ConsiderationItem: typedFields(`${itemField}, address recipient`),
};

const seaportDoc = {
  types: SEAPORT_TYPES,
  primaryType: "OrderComponents",
  domain: {
    name: "Seaport",
    version: "1.6",
    chainId: 11155111,
    verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
  },
  message: {
    offerer: OTHER,
    zone: "0x0000000000000000000000000000000000000000",
    offer: [
      {
        itemType: 2,
        token: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
        identifierOrCriteria: "1",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [],
    orderType: 0,
    startTime: "1700000000",
    endTime: "1700001000",
    zoneHash: `0x${"00".repeat(32)}`,
    salt: "0",
    conduitKey: `0x${"00".repeat(32)}`,
    counter: "0",
  },
};

const safeDoc = {
  types: {
    SafeTx: typedFields(
      "address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce",
    ),
  },
  primaryType: "SafeTx",
  domain: { verifyingContract: "0xD5Ffe748B45F5253fc9975fDd96Fddec052E6D52", chainId: 11155111 },
  message: {
    to: OTHER,
    value: "0",
    data: "0x",
    operation: 1,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: "7",
  },
};

describe("seaport and safe typed data", () => {
  it("a zero-price listing is a danger and logs as `seaport order`", async () => {
    const w = world();
    await w.start();
    const request = await w.requests.prepare(
      evmSign({
        kind: "evm.typed-data",
        network: SEPOLIA,
        account: ACCOUNT,
        typedData: JSON.stringify(seaportDoc),
      }),
    );
    expect(request.risk.map((r) => r.code)).toContain("order-receives-nothing");
    const result = await w.requests.approve(request.id, "evm-sign", VERIFY);
    expect(result).toMatchObject({ kind: "evm.typed-data" });
    const [entry] = await w.requests.signLog();
    expect(entry).toMatchObject({ summary: "seaport order", outcome: "submitted" });
  });

  it("a Safe delegatecall outside MultiSendCallOnly is a danger and logs as `safe tx <nonce>`", async () => {
    const w = world();
    await w.start();
    const request = await w.requests.prepare(
      evmSign({
        kind: "evm.typed-data",
        network: SEPOLIA,
        account: ACCOUNT,
        typedData: JSON.stringify(safeDoc),
      }),
    );
    expect(request.risk.map((r) => r.code)).toContain("safe-delegatecall");
    await w.requests.approve(request.id, "evm-sign", VERIFY);
    const [entry] = await w.requests.signLog();
    expect(entry).toMatchObject({ summary: "safe tx 7" });
  });
});
