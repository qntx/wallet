/**
 * A WalletConnect `session_request` through the shared handlers and pipeline: `request.network`
 * names the CAIP-2 chain the call targets (the in-app browser never sets it and keeps the session's
 * current/default network), the peer's unverified URL feeds the phishing and sign-in checks, its
 * Verify verdict lands in the request's risk, a rejection reaches the caller as 4001, and the sign
 * log persists the peer origin.
 */
import { describe, expect, it } from "vite-plus/test";

import { createMessage } from "@qntx/siwx";
import { evm } from "@qntx/siwx/evm";
import type { SignRequest } from "@qntx/wallet-chains";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";

import { AddressBookController } from "../src/addresses/controller.ts";
import { BitcoinWalletHandler } from "../src/connect/bitcoin.ts";
import type { ConnectionOrigin, ConnectionSession } from "../src/connect/controller.ts";
import {
  BITCOIN_METHODS,
  SESSION_METHODS,
  SOLANA_METHODS,
  sessionAccounts,
} from "../src/connect/controller.ts";
import { Eip1193Handler } from "../src/connect/eip1193.ts";
import { ProviderError, unauthorized } from "../src/connect/errors.ts";
import { SolanaWalletHandler } from "../src/connect/solana.ts";
import { PHISHING_BLOCKED_MESSAGE } from "../src/phishing/status.ts";
import type { PhishingStatus } from "../src/phishing/status.ts";
import {
  AcknowledgementRequiredError,
  RequestController,
  RequestEndedError,
} from "../src/requests/controller.ts";
import { walletConnectKey } from "../src/requests/types.ts";
import type { WalletConnectOrigin, WalletConnectVerify } from "../src/requests/types.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type {
  DisplayIntent,
  PreparedRequest,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import { simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const MAINNET = "eip155:1";
const SEPOLIA = "eip155:11155111";
const SOL_MAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_DEV = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
const BTC_TEST = "bip122:00000000da84f2bafbbc53dee25a72";
const TOPIC = "c".repeat(64);
const PEER_URL = "https://peer.example";
const SITE = "https://app.example";
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const SOL_ADDR = "SoLaNa1111111111111111111111111111111111";
const BTC_PAY = "bc1qpayxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const GROUP = { walletId: "w", groupIndex: 0 };
const ACCOUNT = { kind: "hd" as const, ...GROUP, template: "evm.bip44" as const };
const VERIFY = { kind: "password" as const, password: "pw" };

const peer = (over: Partial<WalletConnectOrigin> = {}): WalletConnectOrigin => ({
  kind: "walletconnect",
  origin: walletConnectKey(over.topic ?? TOPIC),
  topic: over.topic ?? TOPIC,
  url: PEER_URL,
  name: "Peer Dapp",
  verify: { validation: "VALID", isScam: false },
  ...over,
});

const blockedOn =
  (blocked: string) =>
  (url: string): PhishingStatus =>
    url === blocked ? "blocked" : "clear";

const codeOf = async (run: Promise<unknown>): Promise<number | string> =>
  run.then(
    () => "resolved",
    (error: unknown) => (error instanceof ProviderError ? error.code : String(error)),
  );

const testSession = (
  origin: ConnectionOrigin,
  currentNetwork: string,
  scopes: ConnectionSession["scopes"],
): ConnectionSession => ({
  id: "s1",
  origin,
  scopes,
  group: GROUP,
  currentNetwork,
  createdAt: 0,
  lastUsedAt: 0,
});

/** The connections surface all three handlers use: check/authorize/sessionAccounts on one session. */
function connectionStubs(session: ConnectionSession) {
  const authorized: Array<{ origin: string; network: string; method: string }> = [];
  const connections = {
    checkOrigin: (origin: string | WalletConnectOrigin): ConnectionOrigin =>
      typeof origin === "string" ? { kind: "browser", origin } : origin,
    session: (origin: string) => (session.origin.origin === origin ? session : undefined),
    authorize: (origin: string, network: string, method: string) => {
      authorized.push({ origin, network, method });
      const scope = session.origin.origin === origin ? session.scopes[network] : undefined;
      if (scope === undefined || !scope.methods.includes(method)) {
        throw unauthorized();
      }
      return session;
    },
    sessionAccounts: (origin: string, network: string) =>
      sessionAccounts(session.origin.origin === origin ? session : undefined, network),
    request: async () => Promise.reject(new Error("connect requests are not wired in this test")),
    touch: async () => Promise.resolve(),
    revoke: async () => Promise.resolve(),
    getState: () => ({ sessions: {}, pending: {}, ready: true }),
    store: { subscribe: () => () => undefined },
  };
  return { connections, authorized };
}

type Prepared = Array<{
  method: string;
  origin?: unknown;
  network?: string;
  request?: unknown;
}>;

const requestStub = (outcome: () => Promise<unknown>) => {
  const prepared: Prepared = [];
  const requests = {
    prepare: async (input: Prepared[number]) => {
      prepared.push(input);
      await Promise.resolve();
      return { id: "req-1" };
    },
    outcome,
  };
  return { requests, prepared };
};

function eip1193Rig(options: { session: ConnectionSession; outcome?: () => Promise<unknown> }) {
  const { connections, authorized } = connectionStubs(options.session);
  const { requests, prepared } = requestStub(
    options.outcome ?? (async () => Promise.resolve({ signature: new Uint8Array([1]) })),
  );
  const handler = new Eip1193Handler({
    connections: connections as never,
    requests: requests as never,
    networks: {} as never,
    defaultNetwork: () => MAINNET,
    isTracked: () => false,
    delegationState: async () => Promise.resolve({ supported: true, state: "none" }),
    batches: {
      record: async () => Promise.resolve(),
      get: () => undefined,
    },
    txById: () => undefined,
    showCallsStatus: () => undefined,
    now: () => 0,
    random: (n) => new Uint8Array(n),
  });
  return { handler, prepared, authorized };
}

function solanaRig(options: { session: ConnectionSession; outcome?: () => Promise<unknown> }) {
  const { connections, authorized } = connectionStubs(options.session);
  const { requests, prepared } = requestStub(
    options.outcome ??
      (async () =>
        Promise.resolve({ kind: "solana.message", signature: new Uint8Array([1, 2, 3]) })),
  );
  const handler = new SolanaWalletHandler({
    connections: connections as never,
    requests: requests as never,
    solanaAccount: async () =>
      Promise.resolve({ address: SOL_ADDR, publicKey: new Uint8Array(32) }),
    solanaNetwork: () => SOL_MAIN,
  });
  return { handler, prepared, authorized };
}

function bitcoinRig(options: { session: ConnectionSession; outcome?: () => Promise<unknown> }) {
  const { connections, authorized } = connectionStubs(options.session);
  const { requests, prepared } = requestStub(
    options.outcome ??
      (async () => Promise.resolve({ kind: "bitcoin.message", signature: `smpAA==` })),
  );
  const handler = new BitcoinWalletHandler({
    connections: connections as never,
    requests: requests as never,
    bitcoinAccount: async (_group, _network, purpose) =>
      Promise.resolve({ address: `bc1q${purpose}`, publicKey: new Uint8Array(33) }),
    bitcoinNetwork: () => BTC_TEST,
  });
  return { handler, prepared, authorized };
}

describe("Eip1193Handler over a WalletConnect session", () => {
  const WC = peer();
  const wcSession = testSession(WC, MAINNET, {
    [MAINNET]: {
      accounts: [`${MAINNET}:${ADDR}`],
      methods: [...SESSION_METHODS],
      notifications: [],
    },
    [SEPOLIA]: {
      accounts: [`${SEPOLIA}:${ADDR}`],
      methods: [...SESSION_METHODS],
      notifications: [],
    },
  });

  it("personal_sign with request.network targets that network and keeps the peer origin", async () => {
    const r = eip1193Rig({ session: wcSession });
    await r.handler.handle(WC, {
      method: "personal_sign",
      network: SEPOLIA,
      params: ["0x68656c6c6f", ADDR],
    });
    expect(r.authorized).toStrictEqual([
      { origin: WC.origin, network: SEPOLIA, method: "personal_sign" },
    ]);
    expect(r.prepared).toHaveLength(1);
    expect(r.prepared[0]).toMatchObject({ method: "evm-sign", network: SEPOLIA });
    expect(r.prepared[0]?.origin).toStrictEqual(WC);
    const request = r.prepared[0]?.request as { network?: string };
    expect(request.network).toBe(SEPOLIA);
  });

  it("eth_sendTransaction with request.network targets that network", async () => {
    const r = eip1193Rig({
      session: wcSession,
      outcome: async () => Promise.resolve({ hash: "0xabc" }),
    });
    await r.handler.handle(WC, {
      method: "eth_sendTransaction",
      network: SEPOLIA,
      params: [{ from: ADDR, to: "0x00000000000000000000000000000000deadbeef", value: "0x1" }],
    });
    expect(r.prepared[0]?.network).toBe(SEPOLIA);
    const request = r.prepared[0]?.request as { network?: string };
    expect(request.network).toBe(SEPOLIA);
  });

  it("a network the session does not cover is refused", async () => {
    const r = eip1193Rig({ session: wcSession });
    await expect(
      codeOf(
        r.handler.handle(WC, {
          method: "personal_sign",
          network: "eip155:56",
          params: ["0x68656c6c6f", ADDR],
        }),
      ),
    ).resolves.toBe(4100);
    expect(r.prepared).toHaveLength(0);
  });

  it("the injected path without network still uses the session's current network", async () => {
    const browser = testSession({ kind: "browser", origin: SITE }, MAINNET, {
      [MAINNET]: {
        accounts: [`${MAINNET}:${ADDR}`],
        methods: [...SESSION_METHODS],
        notifications: [],
      },
    });
    const r = eip1193Rig({ session: browser });
    await r.handler.handle(SITE, {
      method: "personal_sign",
      params: ["0x68656c6c6f", ADDR],
    });
    expect(r.prepared[0]?.network).toBe(MAINNET);
    expect(r.prepared[0]?.origin).toStrictEqual({ kind: "browser", origin: SITE });
  });
});

describe("SolanaWalletHandler over a WalletConnect session", () => {
  const WC = peer();
  const wcSession = testSession(WC, SOL_DEV, {
    [SOL_DEV]: {
      accounts: [`${SOL_DEV}:${SOL_ADDR}`],
      methods: [...SOLANA_METHODS],
      notifications: [],
    },
  });
  const MESSAGE = new TextEncoder().encode("sign me");

  it("signMessage with request.network authorizes and signs on it", async () => {
    const r = solanaRig({ session: wcSession });
    const result = await r.handler.handle(WC, {
      method: "solana:signMessage",
      network: SOL_DEV,
      params: { message: MESSAGE },
    });
    expect(result).toStrictEqual({
      signature: new Uint8Array([1, 2, 3]),
      signedMessage: MESSAGE,
    });
    expect(r.authorized).toStrictEqual([
      { origin: WC.origin, network: SOL_DEV, method: "solana:signMessage" },
    ]);
    expect(r.prepared[0]?.network).toBe(SOL_DEV);
    expect(r.prepared[0]?.origin).toStrictEqual(WC);
  });

  it("without request.network the wallet's default network applies — and is refused here", async () => {
    const r = solanaRig({ session: wcSession });
    await expect(
      codeOf(r.handler.handle(WC, { method: "solana:signMessage", params: { message: MESSAGE } })),
    ).resolves.toBe(4100);
    expect(r.authorized[0]?.network).toBe(SOL_MAIN);
  });

  it("a rejected pipeline request reaches the caller as 4001", async () => {
    const r = solanaRig({
      session: wcSession,
      outcome: async () => Promise.reject(new RequestEndedError("rejected", undefined)),
    });
    await expect(
      codeOf(
        r.handler.handle(WC, {
          method: "solana:signMessage",
          network: SOL_DEV,
          params: { message: MESSAGE },
        }),
      ),
    ).resolves.toBe(4001);
  });
});

describe("BitcoinWalletHandler over a WalletConnect session", () => {
  const WC = peer();
  const wcSession = testSession(WC, BTC_NET, {
    [BTC_NET]: {
      accounts: [`${BTC_NET}:${BTC_PAY}`, `${BTC_NET}:bc1pord`],
      methods: [...BITCOIN_METHODS],
      notifications: [],
    },
  });
  const MESSAGE = new TextEncoder().encode("sign me");

  it("signMessage with request.network authorizes and signs on it", async () => {
    const r = bitcoinRig({ session: wcSession });
    await r.handler.handle(WC, {
      method: "bitcoin:signMessage",
      network: BTC_NET,
      params: { account: BTC_PAY, message: MESSAGE },
    });
    expect(r.authorized).toStrictEqual([
      { origin: WC.origin, network: BTC_NET, method: "bitcoin:signMessage" },
    ]);
    expect(r.prepared[0]).toMatchObject({
      method: "bitcoin-sign",
      network: BTC_NET,
      account: { ...GROUP, address: BTC_PAY, template: "btc.bip84" },
    });
    expect(r.prepared[0]?.origin).toStrictEqual(WC);
  });

  it("without request.network the wallet's default network applies — and is refused here", async () => {
    const r = bitcoinRig({ session: wcSession });
    await expect(
      codeOf(
        r.handler.handle(WC, {
          method: "bitcoin:signMessage",
          params: { account: BTC_PAY, message: MESSAGE },
        }),
      ),
    ).resolves.toBe(4100);
    expect(r.authorized[0]?.network).toBe(BTC_TEST);
  });

  it("signAndSend results pair each txId with its signed PSBT", async () => {
    const signed = new Uint8Array([9, 9, 9]);
    const r = bitcoinRig({
      session: wcSession,
      outcome: async () =>
        Promise.resolve({ kind: "bitcoin.psbts", signedPsbts: [signed], txids: ["tx-1"] }),
    });
    const result = await r.handler.handle(WC, {
      method: "bitcoin:signAndSendTransaction",
      network: BTC_NET,
      params: {
        inputs: [
          {
            psbt: new Uint8Array([1]),
            chain: "bitcoin:mainnet",
            inputsToSign: [{ address: BTC_PAY, signingIndexes: [0] }],
          },
        ],
      },
    });
    expect(result).toStrictEqual([{ txId: "tx-1", signedPsbt: signed }]);
  });

  it("a broadcast result missing its signed PSBT is an internal error", async () => {
    const r = bitcoinRig({
      session: wcSession,
      outcome: async () =>
        Promise.resolve({ kind: "bitcoin.psbts", signedPsbts: [], txids: ["tx-1"] }),
    });
    await expect(
      codeOf(
        r.handler.handle(WC, {
          method: "bitcoin:signAndSendTransaction",
          network: BTC_NET,
          params: {
            inputs: [
              {
                psbt: new Uint8Array([1]),
                chain: "bitcoin:mainnet",
                inputsToSign: [{ address: BTC_PAY, signingIndexes: [0] }],
              },
            ],
          },
        }),
      ),
    ).resolves.toBe(-32603);
  });

  it("a rejected pipeline request reaches the caller as 4001", async () => {
    const r = bitcoinRig({
      session: wcSession,
      outcome: async () => Promise.reject(new RequestEndedError("rejected", undefined)),
    });
    await expect(
      codeOf(
        r.handler.handle(WC, {
          method: "bitcoin:signMessage",
          network: BTC_NET,
          params: { account: BTC_PAY, message: MESSAGE },
        }),
      ),
    ).resolves.toBe(4001);
  });
});

const intent = (): DisplayIntent =>
  ({
    family: "evm",
    network: SEPOLIA,
    summary: "transfer",
    outflows: [
      {
        to: "0x00000000000000000000000000000000deadbeef",
        amount: { asset: "native", amount: "1", decimals: 18 },
        verified: true,
      },
    ],
    approvals: [],
    fee: undefined,
    warnings: [],
    verifiability: "full",
  }) as unknown as DisplayIntent;

const tracked = (): TrackedTransaction => ({
  id: "tx-1",
  family: "evm",
  network: SEPOLIA,
  account: "w",
  hash: "0x1",
  state: "submitted",
  intent: intent(),
  nonce: 0,
  submittedAt: 0,
  error: undefined,
});

async function pipeline(status: (url: string) => PhishingStatus = () => "clear") {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const openStore = async () => Promise.resolve(createMemoryEngineStore(backing));
  const logger = { warn: () => undefined };
  let counter = 0;
  const random = (n: number): Uint8Array => {
    counter += 1;
    return new Uint8Array(n).fill(counter % 251);
  };
  const addressBook = new AddressBookController({ openStore, random, now: () => 0, logger });
  const transactions = {
    getState: () => ({ txs: {} }),
    prepareSend: async (_p: unknown, requestId: string): Promise<PreparedRequest> =>
      Promise.resolve({
        txId: `tx-${requestId}`,
        account: ACCOUNT,
        network: SEPOLIA,
        intent: intent(),
        checks: [],
        staleReason: () => undefined,
        submit: async (_verify: unknown, commit: () => void) => {
          commit();
          await Promise.resolve();
          return tracked();
        },
        release: () => undefined,
      }),
    prepareDapp: async (account: unknown, request: SignRequest) => {
      const normalized = normalizeEvm(request);
      await Promise.resolve();
      return {
        account,
        network: normalized.network,
        signer: ADDR,
        intent: decodeEvm(normalized, ADDR),
        checks: [],
        staleReason: () => undefined,
        release: () => undefined,
        submit: async () => Promise.resolve({ kind: normalized.kind, signature: "0x12" }),
      };
    },
  } as unknown as TransactionController;
  const requests = new RequestController({
    phishing: { check: status },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    addressBook,
    openStore,
    fetch: globalThis.fetch,
    random,
    now: () => 1000,
    setTimer: () => () => undefined,
    logger,
  });
  await addressBook.init();
  await requests.init();
  return { requests };
}

const wcSend = (origin: WalletConnectOrigin) => ({
  method: "send" as const,
  origin,
  account: ACCOUNT,
  network: SEPOLIA,
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 1n,
  fee: "normal" as const,
});

const siwe = (domain: string): string =>
  evm().format(
    createMessage({
      domain,
      address: ADDR,
      uri: `https://${domain}/login`,
      version: "1",
      chainId: "1",
      nonce: "12341234",
      issuedAt: "2022-03-17T12:45:13.610Z",
    }),
  );

const siweSign = (domain: string, origin: WalletConnectOrigin) => ({
  method: "evm-sign" as const,
  origin,
  account: ACCOUNT,
  network: MAINNET,
  request: {
    kind: "evm.personal-message" as const,
    network: MAINNET,
    account: ACCOUNT,
    message: new TextEncoder().encode(siwe(domain)),
  },
});

describe("the request pipeline over a WalletConnect origin", () => {
  const verifyRisk = (request: { risk: ReadonlyArray<{ code: string }> }) =>
    request.risk.filter((finding) => finding.code.startsWith("verify-"));

  it("a peer URL on the phishing list fails the prepare", async () => {
    const { requests } = await pipeline(blockedOn(PEER_URL));
    await expect(requests.prepare(wcSend(peer()))).rejects.toThrow(PHISHING_BLOCKED_MESSAGE);
  });

  it.each<[string, WalletConnectVerify, ReadonlyArray<{ code: string; level: string }>]>([
    [
      "INVALID validation",
      { validation: "INVALID", isScam: false },
      [{ code: "verify-mismatch", level: "danger" }],
    ],
    [
      "a flagged domain",
      { validation: "VALID", isScam: true },
      [{ code: "verify-threat", level: "danger" }],
    ],
    [
      "both",
      { validation: "INVALID", isScam: true },
      [
        { code: "verify-threat", level: "danger" },
        { code: "verify-mismatch", level: "danger" },
      ],
    ],
    ["UNKNOWN", { validation: "UNKNOWN", isScam: false }, []],
  ])("the Verify verdict %s lands in the request's risk", async (_name, verify, expected) => {
    const { requests } = await pipeline();
    const request = await requests.prepare(wcSend(peer({ verify })));
    expect(verifyRisk(request)).toStrictEqual(expected);
  });

  it("an approval must acknowledge the Verify danger findings", async () => {
    const { requests } = await pipeline();
    const request = await requests.prepare(
      wcSend(peer({ verify: { validation: "INVALID", isScam: false } })),
    );
    await expect(requests.approve(request.id, "send", { verify: VERIFY })).rejects.toBeInstanceOf(
      AcknowledgementRequiredError,
    );
    await requests.approve(request.id, "send", approval(request, VERIFY));
    await expect(requests.outcome(request.id)).resolves.toMatchObject({ id: "tx-1" });
  });

  it("invalidateOrigin ends a WalletConnect-originated request", async () => {
    const { requests } = await pipeline();
    const origin = peer();
    const request = await requests.prepare(wcSend(origin));
    requests.invalidateOrigin(origin.origin);
    expect(requests.getState().requests[request.id]?.stage).toBe("invalidated");
  });

  it("a second concurrent request from the same session key is OriginBusyError", async () => {
    const { requests } = await pipeline();
    const origin = peer();
    const first = await requests.prepare(wcSend(origin));
    expect(first.origin).toStrictEqual(origin);
    await expect(requests.prepare(wcSend(origin))).rejects.toMatchObject({
      name: "OriginBusyError",
    });
  });

  it("a SIWE domain that is not the peer's URL host is refused; one matching it passes", async () => {
    const { requests } = await pipeline();
    const origin = peer();
    await expect(requests.prepare(siweSign("victim.example", origin))).rejects.toMatchObject({
      name: "SignInOriginError",
    });
    const request = await requests.prepare(siweSign("peer.example", origin));
    expect(request.stage).toBe("awaiting-approval");
  });

  it("the sign log writes and reads back a WalletConnect origin", async () => {
    const { requests } = await pipeline();
    const origin = peer();
    const request = await requests.prepare(wcSend(origin));
    requests.reject(request.id);
    const entries = await requests.signLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.origin).toStrictEqual(origin);
    expect(entries[0]?.outcome).toBe("rejected");
  });
});
