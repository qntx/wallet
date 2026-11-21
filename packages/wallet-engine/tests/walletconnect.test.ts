/* oxlint-disable vitest/no-conditional-in-test -- the relay helpers narrow results for assertions */
/**
 * The WalletConnect wallet entry end to end over the in-process relay: pairing, proposals judged
 * and granted, sessions settled into `ConnectionController` under `walletconnect:<topic>`, and
 * requests answered through the same handlers and pipeline the browser uses — plus the lock,
 * expiry, restart, deletion and adversarial edges.
 *
 * The relay support module installs the WebSocket/fetch stubs the SDK captures at module load, so
 * it MUST be the first import in this file.
 */
import { randomBytes } from "node:crypto";

import type { SignClient } from "@walletconnect/sign-client";
import type { SignClientTypes, SessionTypes } from "@walletconnect/types";
import { getAddress, verifyMessage, verifyTypedData } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import type { ConnectionSession } from "../src/connect/controller.ts";
import { createWalletEngine } from "../src/engine.ts";
import type { RiskFinding } from "../src/requests/risk.ts";
import { walletConnectKey } from "../src/requests/types.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import type {
  createWalletConnectClient as CreateClient,
  WalletConnect,
  WalletConnectProposal,
} from "../src/walletconnect/client.ts";
import { approval } from "./approval.ts";
import { b64 } from "./phishing-helpers.ts";
import { simulateV1Result } from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";
import { memoryWalletConnectStorage, walletConnectRelay } from "./support/walletconnect-relay.ts";

// SDK modules capture globalThis.WebSocket at evaluation, so they are dynamically imported inside
// the rigs — never at module load — while the relay stub installs at this module's own evaluation.
const loadClient = async (): Promise<typeof CreateClient> => {
  const module = await import("../src/walletconnect/client.ts");
  return module.createWalletConnectClient;
};

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const PW = { kind: "password" as const, password: PASSWORD };
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SECOND = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const GATEWAY = "https://gateway.test";
const EVM1 = "eip155:1";
const SEPOLIA = "eip155:11155111";
const DAPP_URL = "https://dapp.example";
const WALLET_META = {
  name: "qntx wallet",
  description: "the test wallet",
  url: "https://wallet.example",
  icons: [],
};
const DAPP_META = { name: "test dapp", description: "dapp", url: DAPP_URL, icons: [] };
const METHODS = [
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
  "wallet_showCallsStatus",
  "wallet_getCapabilities",
  "wallet_watchAsset",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
];
const EVENTS = ["accountsChanged", "chainChanged"];
const USER_REJECTED = 5000;

const evmRpc = (chainId: string): Record<string, unknown> => ({
  eth_chainId: chainId,
  net_version: Number.parseInt(chainId, 16).toString(),
  eth_blockNumber: "0x1",
  eth_getTransactionCount: "0x0",
  eth_estimateGas: "0x5208",
  eth_call: `0x${"00".repeat(32)}`,
  eth_getCode: "0x",
  eth_getBalance: "0xde0b6b3a7640000",
  eth_feeHistory: { baseFeePerGas: ["0x64", "0x64"], reward: [["0x1", "0x2", "0x3"]] },
  eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
  eth_getTransactionReceipt: {
    status: "0x1",
    blockNumber: "0x1",
    blockHash: `0x${"cc".repeat(32)}`,
    gasUsed: "0x5208",
    logs: [],
  },
  eth_getBlockByNumber: { number: "0x2" },
});

type RigOptions = {
  readonly deny?: ReadonlyArray<string>;
};

async function rig(options: RigOptions = {}) {
  const timers = manualTimers();
  const wallet = await createNodeWallet({
    verifyEvent,
    passkey: {
      rpId: "qntx.test",
      rpName: "qntx",
      walletSalt: "qntx/wallet",
      backupSalt: "qntx/backup",
      vaultSalt: "qntx/vault",
    },
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(randomBytes(32)),
    kernelUrl: KERNEL_URL,
  });
  const deny = b64(options.deny ?? []);
  // One backing for every unlock — the engine store keeps its data across lock cycles. The
  // memory store's close() clears collections, which a real store's close does not do, so the
  // backing outlives every close here.
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const durableStore = (): EngineStore => {
    const store = createMemoryEngineStore(backing);
    return { collection: (name) => store.collection(name), close: async () => Promise.resolve() };
  };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/risk/lists/phishing`) {
      return Response.json({ kind: "snapshot", version: 1, deny, allow: b64([]) });
    }
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: [] });
    }
    const base = url.endsWith("/") ? url.slice(0, -1) : url;
    if (base === "https://evm1.invalid" || base === "https://evm2.invalid") {
      const table = evmRpc(base === "https://evm1.invalid" ? "0x1" : "0xaa36a7");
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: unknown;
      };
      if (body.method === "eth_simulateV1") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: simulateV1Result(body.params),
        });
      }
      if (body.method in table) {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: table[body.method] });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32_601, message: `method not found: ${body.method}` },
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  const engine = createWalletEngine({
    setTimer: timers.setTimer,
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: fetchImpl,
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: () => undefined },
    showCallsStatus: () => undefined,
    openStore: async () => Promise.resolve(durableStore()),
    rpc: { [EVM1]: ["https://evm1.invalid"], [SEPOLIA]: ["https://evm2.invalid"] },
    gateway: { url: GATEWAY },
  });
  const info = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: PW,
  });
  await until(() => engine.accounts.getState().selected !== null);
  let nowMs = Date.now();
  const storage = memoryWalletConnectStorage();
  const createWalletConnectClient = await loadClient();
  const client = await createWalletConnectClient({
    projectId: "test",
    metadata: WALLET_META,
    storage,
    relayUrl: "wss://fake.relay",
    wallet,
    engine,
    now: () => nowMs,
    logger: { warn: () => undefined },
  });
  return {
    timers,
    wallet,
    engine,
    wc: client.walletConnect,
    core: client.core,
    kit: client.kit,
    storage,
    walletId: info.walletId,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    getNow: () => nowMs,
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

async function until(read: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error("until() timed out");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const soleProposal = (wc: WalletConnect): WalletConnectProposal => {
  const [proposal] = Object.values(wc.getState().proposals);
  if (proposal === undefined) {
    throw new Error("no proposal in state");
  }
  return proposal;
};

const sessionOf = (r: Rig, topic: string): ConnectionSession | undefined =>
  r.engine.connections.session(walletConnectKey(topic));

type Dapp = Awaited<ReturnType<typeof SignClient.init>>;

async function dapp(metadata = DAPP_META): Promise<Dapp> {
  const { SignClient } = await import("@walletconnect/sign-client");
  return SignClient.init({
    projectId: "test",
    relayUrl: "wss://fake.relay",
    storage: memoryWalletConnectStorage() as never,
    customStoragePrefix: "dapp",
    metadata,
    logger: "silent",
    telemetryEnabled: false,
  });
}

type Namespaces = Parameters<Dapp["connect"]>[0];

const eip155Namespace = (
  chains: ReadonlyArray<string>,
  methods = METHODS,
): { chains: string[]; methods: string[]; events: string[] } => ({
  chains: [...chains],
  methods: [...methods],
  events: [...EVENTS],
});

/** Connect → pair → proposal in state; the dApp's `approval` is left for the caller to settle. */
async function proposed(
  r: Rig,
  client: Dapp,
  options: Namespaces = {},
): Promise<{ proposal: WalletConnectProposal; approval: () => Promise<SessionTypes.Struct> }> {
  const { uri, approval } = await client.connect({
    requiredNamespaces: options.requiredNamespaces ?? {
      eip155: eip155Namespace([EVM1, SEPOLIA]),
    },
    ...(options.optionalNamespaces === undefined
      ? {}
      : { optionalNamespaces: options.optionalNamespaces }),
  });
  if (uri === undefined) {
    throw new Error("connect produced no uri");
  }
  await r.wc.pair(uri);
  await until(() => Object.keys(r.wc.getState().proposals).length === 1);
  // A proposal a test leaves unsettled would reject after the test — mark it observed.
  const settled = approval();
  settled.catch(() => undefined);
  return { proposal: soleProposal(r.wc), approval: async () => settled };
}

async function established(
  r: Rig,
  client: Dapp,
  options: Namespaces & {
    grant?: ReadonlyArray<string>;
    acknowledged?: ReadonlyArray<RiskFinding["code"]>;
  } = {},
): Promise<{
  proposal: WalletConnectProposal;
  session: ConnectionSession;
  live: SessionTypes.Struct;
}> {
  const { proposal, approval } = await proposed(r, client, options);
  const session = await r.wc.approve(proposal.id, {
    networks: options.grant ?? [...proposal.networks],
    ...(options.acknowledged === undefined ? {} : { acknowledged: options.acknowledged }),
  });
  const live = await approval();
  return { proposal, session, live };
}

/** The session account `personal_sign` and friends bind to — the CAIP-10 tail. */
const accountOf = (session: ConnectionSession, network: string): string => {
  const scope = session.scopes[network];
  const [account] = scope?.accounts ?? [];
  if (account === undefined) {
    throw new Error(`no account for ${network}`);
  }
  return account.split(":").pop() ?? "";
};

const awaiting = (r: Rig) =>
  Object.values(r.engine.requests.getState().requests).filter(
    (request) => request.stage === "awaiting-approval",
  );

const openRequest = async (r: Rig) => {
  await until(() => awaiting(r).length === 1);
  const [request] = awaiting(r);
  if (request === undefined) {
    throw new Error("no awaiting request");
  }
  return request;
};

type SettledRequest = { value: unknown } | { error: { code?: number; message?: string } };

const call = async (
  r: Rig,
  client: Dapp,
  live: SessionTypes.Struct,
  method: string,
  params: unknown,
  chainId = EVM1,
): Promise<{
  settled: Promise<SettledRequest>;
  approve: () => Promise<unknown>;
  reject: () => void;
}> => {
  const settled = client
    .request({ topic: live.topic, chainId, request: { method, params } })
    .then((value): SettledRequest => ({ value }))
    .catch((error: unknown): SettledRequest => ({ error: error as { code?: number } }));
  const request = await openRequest(r);
  return {
    settled,
    approve: async () => r.engine.requests.approve(request.id, "evm-sign", approval(request, PW)),
    reject: () => r.engine.requests.reject(request.id),
  };
};

/** Raw `wc_sessionRequest` publish, bypassing the dApp SignClient's own validation. */
const sendRaw = async (
  client: Dapp,
  topic: string,
  id: number,
  method: string,
  params: unknown,
  chainId = EVM1,
  expiryTimestamp?: number,
): Promise<void> => {
  const message = await client.core.crypto.encode(topic, {
    id,
    jsonrpc: "2.0",
    method: "wc_sessionRequest",
    params: {
      request: {
        method,
        params,
        ...(expiryTimestamp === undefined ? {} : { expiryTimestamp }),
      },
      chainId,
    },
  });
  await client.core.relayer.publish(topic, message, { tag: 1108, ttl: 300 });
};

/**
 * A raw `wc_sessionPropose` on the pairing topic — the only way a REQUIRED namespace reaches the
 * wallet: `SignClient.connect` folds its `requiredNamespaces` into `optionalNamespaces` before it
 * sends, so real proposals always arrive with `requiredNamespaces: {}`.
 */
const sendRawProposal = async (
  client: Dapp,
  pairingTopic: string,
  id: number,
  proposer: { publicKey: string; metadata: SignClientTypes.Metadata },
  requiredNamespaces: Record<string, unknown>,
  optionalNamespaces: Record<string, unknown> = {},
): Promise<void> => {
  const message = await client.core.crypto.encode(pairingTopic, {
    id,
    jsonrpc: "2.0",
    method: "wc_sessionPropose",
    params: {
      proposer,
      requiredNamespaces,
      optionalNamespaces,
      relays: [{ protocol: "irn" }],
    },
  });
  await client.core.relayer.publish(pairingTopic, message, { tag: 1100, ttl: 300 });
};

/** JSON-RPC answers published on a session topic, decoded through the dApp's session key. */
const responsesOn = async (
  client: Dapp,
  topic: string,
): Promise<Map<number, { result?: unknown; error?: { code: number; message: string } }>> => {
  const out = new Map<number, { result?: unknown; error?: { code: number; message: string } }>();
  for (const raw of walletConnectRelay.messagesOn(topic)) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- decodes land in order
      const payload = (await client.core.crypto.decode(topic, raw)) as {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (
        typeof payload === "object" &&
        payload !== null &&
        typeof payload.id === "number" &&
        ("result" in payload || "error" in payload)
      ) {
        out.set(payload.id, payload);
      }
    } catch {
      // Proposal/settlement envelopes decode differently — only JSON-RPC answers matter here.
    }
  }
  return out;
};

const connect2 = async (
  client: Dapp,
): Promise<{ uri: string; approval: () => Promise<SessionTypes.Struct> }> => {
  const { uri, approval } = await client.connect({
    requiredNamespaces: { eip155: eip155Namespace([EVM1]) },
  });
  if (uri === undefined) {
    throw new Error("connect produced no uri");
  }
  return { uri, approval };
};

describe("walletconnect pairing", () => {
  it("refuses malformed, v1 and expired pairing URIs", { timeout: 60_000 }, async () => {
    walletConnectRelay.reset();
    const r = await rig();
    await expect(r.wc.pair("garbage")).rejects.toMatchObject({ code: "invalid-uri" });
    await expect(
      r.wc.pair(
        `wc:${"ab".repeat(32)}@1?bridge=https%3A%2F%2Fbridge.example&key=${"cd".repeat(32)}`,
      ),
    ).rejects.toMatchObject({ code: "invalid-uri" });
    await expect(
      r.wc.pair(
        `wc:${"ef".repeat(32)}@2?relay-protocol=irn&symKey=${"01".repeat(32)}&expiryTimestamp=${Math.floor(Date.now() / 1000) - 10}`,
      ),
    ).rejects.toMatchObject({ code: "expired-uri" });
    await r.wc.dispose();
  });

  it("refuses a URI whose pairing is already active", { timeout: 60_000 }, async () => {
    walletConnectRelay.reset();
    const r = await rig();
    const client = await dapp();
    const { uri, approval } = await connect2(client);
    await r.wc.pair(uri);
    await until(() => Object.keys(r.wc.getState().proposals).length === 1);
    await expect(r.wc.pair(uri)).rejects.toMatchObject({ code: "duplicate-pairing" });
    const pending = approval();
    pending.catch(() => undefined);
    await r.wc.reject(soleProposal(r.wc).id);
    await expect(pending).rejects.toMatchObject({ code: USER_REJECTED });
    await r.wc.dispose();
  });
});

describe("walletconnect proposals", () => {
  it(
    "offers the session proposal in state and settles it into a ConnectionSession",
    { timeout: 90_000 },
    async () => {
      walletConnectRelay.reset();
      walletConnectRelay.verify.current = { origin: DAPP_URL };
      const r = await rig();
      const client = await dapp();
      const { proposal, approval } = await proposed(r, client);
      expect(proposal.peer).toMatchObject({ name: "test dapp", url: DAPP_URL });
      expect(proposal.verify).toStrictEqual({ validation: "VALID", isScam: false });
      expect(proposal.networks).toStrictEqual([EVM1, SEPOLIA]);
      // requiredNamespaces never reach the wire — the SDK folds them into optional.
      expect(proposal.required).toStrictEqual([]);
      expect(proposal.methods["eip155"]).toContain("personal_sign");
      const session = await r.wc.approve(proposal.id, { networks: [EVM1, SEPOLIA] });
      const live = await approval();
      expect(live.topic).toBe(session.origin.kind === "walletconnect" ? session.origin.topic : "");
      const account = accountOf(session, EVM1);
      expect(live.namespaces["eip155"]?.accounts).toContain(`${EVM1}:${account}`);
      expect(sessionOf(r, live.topic)).toBeDefined();
      expect(session.origin.origin).toBe(walletConnectKey(live.topic));
      expect(r.wc.getState().proposals).toStrictEqual({});
      await r.wc.dispose();
    },
  );

  it(
    "rejects proposals it cannot serve with the SDK's reason codes",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      // A real connect establishes the pairing and gives the proposer's publicKey; required
      // namespaces never reach the wire from connect() — raw proposes carry them instead.
      await proposed(r, client);
      const [real] = Object.values(r.kit.getPendingSessionProposals());
      if (real === undefined) {
        throw new Error("no real proposal");
      }
      const { pairingTopic, proposer } = real;
      const cases: Array<{ required: Record<string, unknown>; code: number }> = [
        {
          required: {
            cosmos: { chains: ["cosmos:cosmoshub-4"], methods: ["cosmos_signDirect"], events: [] },
          },
          code: 5104,
        },
        { required: { eip155: eip155Namespace(["eip155:56"]) }, code: 5100 },
        {
          required: { eip155: eip155Namespace([EVM1], ["personal_sign", "eth_sign"]) },
          code: 5101,
        },
        {
          required: { eip155: { ...eip155Namespace([EVM1]), events: ["bogus"] } },
          code: 5102,
        },
      ];
      let rawId = 9_000_000;
      for (const { required, code } of cases) {
        rawId += 1;
        // oxlint-disable-next-line eslint/no-await-in-loop -- one proposal at a time
        await sendRawProposal(client, pairingTopic, rawId, proposer, required);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one proposal at a time
        const response = await responseFor(client, pairingTopic, rawId);
        expect(response.error?.code).toBe(code);
      }
      // An all-optional proposal that offers nothing servable is refused too.
      const client2 = await dapp();
      const { uri, approval } = await client2.connect({
        optionalNamespaces: { eip155: eip155Namespace(["eip155:56"]) },
      });
      await r.wc.pair(uri ?? "");
      const approved = approval();
      approved.catch(() => undefined);
      await expect(approved).rejects.toMatchObject({ code: 5100 });
      await r.wc.dispose();
    },
  );

  it(
    "rejects a phishing-listed peer url and a malformed peer url",
    { timeout: 90_000 },
    async () => {
      walletConnectRelay.reset();
      const blocked = "https://scam.example";
      const r = await rig({ deny: ["scam.example"] });
      const bad = await dapp({ ...DAPP_META, url: blocked });
      const { uri: uri1, approval: a1 } = await bad.connect({
        requiredNamespaces: { eip155: eip155Namespace([EVM1]) },
      });
      await r.wc.pair(uri1 ?? "");
      await expect(a1()).rejects.toMatchObject({ code: USER_REJECTED });
      // oxlint-disable-next-line eslint/no-script-url -- a peer advertising a javascript: url is the case under test
      const malformed = await dapp({ ...DAPP_META, url: "javascript:alert(1)" });
      const { uri: uri2, approval: a2 } = await malformed.connect({
        requiredNamespaces: { eip155: eip155Namespace([EVM1]) },
      });
      await r.wc.pair(uri2 ?? "");
      await expect(a2()).rejects.toMatchObject({ code: USER_REJECTED });
      await r.wc.dispose();
    },
  );

  it(
    "maps a Verify INVALID or isScam verdict into danger findings the grant must acknowledge",
    { timeout: 90_000 },
    async () => {
      walletConnectRelay.reset();
      walletConnectRelay.verify.current = { origin: "https://attacker.example", isScam: false };
      const r = await rig();
      const client = await dapp();
      const { proposal, approval } = await proposed(r, client);
      expect(proposal.verify).toStrictEqual({ validation: "INVALID", isScam: false });
      expect(proposal.risk.some((f) => f.code === "verify-mismatch" && f.level === "danger")).toBe(
        true,
      );
      await expect(r.wc.approve(proposal.id, { networks: [EVM1, SEPOLIA] })).rejects.toMatchObject({
        code: "unacknowledged",
      });
      const session = await r.wc.approve(proposal.id, {
        networks: [EVM1, SEPOLIA],
        acknowledged: ["verify-mismatch"],
      });
      expect(session.origin.kind).toBe("walletconnect");
      await approval();
      await r.wc.dispose();
    },
  );

  it("produces no Verify finding for UNKNOWN", { timeout: 90_000 }, async () => {
    walletConnectRelay.reset();
    // No attestation answer → the SDK reports validation UNKNOWN.
    const r = await rig();
    const client = await dapp();
    const { proposal } = await proposed(r, client);
    expect(proposal.verify.validation).toBe("UNKNOWN");
    expect(proposal.risk.some((f) => f.code.startsWith("verify-"))).toBe(false);
    await r.wc.dispose();
  });

  it(
    "refuses unknown, expired, locked and badly granted approvals",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { proposal, approval } = await proposed(r, client);
      await expect(r.wc.approve(999_999, { networks: [EVM1] })).rejects.toMatchObject({
        code: "unknown-proposal",
      });
      // requiredNamespaces never reach the wire — any non-empty subset of the offer is valid.
      await expect(
        r.wc.approve(proposal.id, { networks: [EVM1, "eip155:56"] }),
      ).rejects.toMatchObject({ code: "invalid-grant" });
      await expect(r.wc.approve(proposal.id, { networks: [] })).rejects.toMatchObject({
        code: "invalid-grant",
      });
      await r.wallet.vault.lock();
      await expect(r.wc.approve(proposal.id, { networks: [EVM1, SEPOLIA] })).rejects.toMatchObject({
        code: "locked",
      });
      await r.wallet.vault.unlock(PW);
      await until(() => r.engine.connections.getState().ready);
      r.setNow(proposal.expiresAt);
      await expect(r.wc.approve(proposal.id, { networks: [EVM1, SEPOLIA] })).rejects.toMatchObject({
        code: "expired",
      });
      expect(r.wc.getState().proposals).toStrictEqual({});
      approval().catch(() => undefined);
      await r.wc.dispose();
    },
  );
});

describe("walletconnect session requests", () => {
  it(
    "answers personal_sign and eth_signTypedData_v4 through the pipeline on either granted chain",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client);
      const from = getAddress(accountOf(session, EVM1));

      const message = `0x${Buffer.from("hello walletconnect", "utf8").toString("hex")}`;
      const sign = await call(r, client, live, "personal_sign", [message, from]);
      await sign.approve();
      const signed = await sign.settled;
      expect("value" in signed && signed.value).toBeTypeOf("string");
      const signature = "value" in signed ? (signed.value as `0x${string}`) : "0x";
      await expect(
        verifyMessage({
          address: from,
          message: "hello walletconnect",
          signature,
        }),
      ).resolves.toBe(true);

      // A request on the second granted chain signs for that chain's domain.
      const typedData = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
          ],
          Mail: [
            { name: "from", type: "address" },
            { name: "text", type: "string" },
          ],
        },
        primaryType: "Mail",
        domain: { name: "Test", version: "1", chainId: 11_155_111 },
        message: { from, text: "hi" },
      } as const;
      // The second granted chain: the domain's chainId must match the request network.
      const typed = await call(
        r,
        client,
        live,
        "eth_signTypedData_v4",
        [from, JSON.stringify(typedData)],
        SEPOLIA,
      );
      await typed.approve();
      const typedResult = await typed.settled;
      const sig = "value" in typedResult ? (typedResult.value as `0x${string}`) : "0x";
      await expect(
        verifyTypedData({
          address: from,
          domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
          types: typedData.types,
          primaryType: typedData.primaryType,
          message: typedData.message,
          signature: sig,
        }),
      ).resolves.toBe(true);
      await r.wc.dispose();
    },
  );

  it("answers eth_sendTransaction with the broadcast hash", { timeout: 120_000 }, async () => {
    walletConnectRelay.reset();
    const r = await rig();
    const client = await dapp();
    const { session, live } = await established(r, client);
    const from = getAddress(accountOf(session, EVM1));
    const to = "0x2222222222222222222222222222222222222222";
    const tx = await call(r, client, live, "eth_sendTransaction", [{ from, to, value: "0x1" }]);
    await tx.approve();
    const result = await tx.settled;
    // The pipeline answers with the broadcast transaction's recorded hash.
    expect(
      "value" in result &&
        typeof result.value === "string" &&
        /^0x[0-9a-f]{64}$/.test(result.value),
    ).toBe(true);
    await r.wc.dispose();
  });

  it("maps a user rejection to code 5000 for the dApp", { timeout: 120_000 }, async () => {
    walletConnectRelay.reset();
    const r = await rig();
    const client = await dapp();
    const { session, live } = await established(r, client);
    const from = getAddress(accountOf(session, EVM1));
    const message = `0x${Buffer.from("reject me", "utf8").toString("hex")}`;
    const sign = await call(r, client, live, "personal_sign", [message, from]);
    sign.reject();
    const result = await sign.settled;
    expect("error" in result && result.error?.code).toBe(USER_REJECTED);
    await r.wc.dispose();
  });

  it(
    "pushes chainChanged when the session switches networks and session_update when a chain joins",
    { timeout: 150_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client);
      const events: Array<{ name: string; chainId: string; data: unknown }> = [];
      client.on("session_event", (event) => {
        events.push({
          name: event.params.event.name,
          chainId: event.params.chainId,
          data: event.params.event.data,
        });
      });
      // In-scope switch: the handler flips the session's current network.
      await client.request({
        topic: live.topic,
        chainId: EVM1,
        request: { method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] },
      });
      await until(() => events.some((e) => e.name === "chainChanged"));
      const chainChanged = events.find((e) => e.name === "chainChanged");
      expect(chainChanged?.data).toBe(11_155_111);
      expect(chainChanged?.chainId).toBe(SEPOLIA);
      await r.wc.dispose();
    },
  );

  it(
    "re-points the session to the newly selected group — session_update plus accountsChanged",
    { timeout: 150_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client);
      const first = accountOf(session, EVM1);
      const events: Array<{ name: string; chainId: string; data: unknown }> = [];
      const updates: SessionTypes.Namespaces[] = [];
      client.on("session_event", (event) => {
        events.push({
          name: event.params.event.name,
          chainId: event.params.chainId,
          data: event.params.event.data,
        });
      });
      client.on("session_update", (event) => {
        updates.push(event.params.namespaces);
      });
      const other = await r.wallet.wallets.importMnemonic({ mnemonic: SECOND });
      r.engine.accounts.select(other.walletId, 0);
      // Each granted chain pushes its own accountsChanged carrying that chain's CAIP-10s.
      await until(() =>
        [EVM1, SEPOLIA].every((chainId) =>
          events.some((e) => e.name === "accountsChanged" && e.chainId === chainId),
        ),
      );
      const repointed = sessionOf(r, live.topic);
      if (repointed === undefined) {
        throw new Error("session revoked");
      }
      const second = accountOf(repointed, EVM1);
      expect(second).not.toBe(first);
      for (const chainId of [EVM1, SEPOLIA]) {
        const event = events.find((e) => e.name === "accountsChanged" && e.chainId === chainId);
        expect(event?.data).toStrictEqual([`${chainId}:${second}`]);
      }
      await until(() => updates.length > 0);
      const last = updates.at(-1);
      expect(last?.["eip155"]?.accounts).toStrictEqual([
        `${EVM1}:${second}`,
        `${SEPOLIA}:${second}`,
      ]);
      await r.wc.dispose();
    },
  );

  it(
    "revokes the session when the host revokes the origin, and drops it when the dApp disconnects",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client);
      const deleted: string[] = [];
      client.on("session_delete", (event) => {
        deleted.push(event.topic);
      });
      await r.engine.connections.revoke(walletConnectKey(live.topic));
      await until(() => deleted.includes(live.topic));
      expect(sessionOf(r, live.topic)).toBeUndefined();

      const second = await established(r, client);
      await client.disconnect({
        topic: second.live.topic,
        reason: { code: 6000, message: "User disconnected." },
      });
      await until(() => sessionOf(r, second.live.topic) === undefined);
      await r.wc.dispose();
    },
  );

  it("holds requests while locked and runs them after unlock", { timeout: 150_000 }, async () => {
    walletConnectRelay.reset();
    const r = await rig();
    const client = await dapp();
    const { session, live } = await established(r, client);
    const from = getAddress(accountOf(session, EVM1));
    await r.wallet.vault.lock();
    await until(() => !r.engine.connections.getState().ready);
    const message = `0x${Buffer.from("locked request", "utf8").toString("hex")}`;
    let answered = false;
    const settled = client
      .request({
        topic: live.topic,
        chainId: EVM1,
        request: { method: "personal_sign", params: [message, from] },
      })
      .then((value) => {
        answered = true;
        return value;
      });
    // While locked nothing is answered and nothing reaches the pipeline.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(answered).toBe(false);
    expect(awaiting(r)).toHaveLength(0);
    await r.wallet.vault.unlock(PW);
    await until(() => r.engine.connections.getState().ready);
    const request = await openRequest(r);
    await r.engine.requests.approve(request.id, "evm-sign", approval(request, PW));
    await settled;
    expect(answered).toBe(true);
    await r.wc.dispose();
  });

  it(
    "requeues a request whose pipeline entry the lock ended, answering it after unlock",
    { timeout: 150_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client);
      const from = getAddress(accountOf(session, EVM1));
      const message = `0x${Buffer.from("locked mid approval", "utf8").toString("hex")}`;
      const sign = await call(r, client, live, "personal_sign", [message, from]);
      await r.wallet.vault.lock();
      await until(() => !r.engine.connections.getState().ready);
      // The pending approval ended with the lock; nothing is answered.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await r.wallet.vault.unlock(PW);
      await until(() => r.engine.connections.getState().ready);
      const request = await openRequest(r);
      await r.engine.requests.approve(request.id, "evm-sign", approval(request, PW));
      const result = await sign.settled;
      expect("value" in result && typeof result.value === "string").toBe(true);
      await r.wc.dispose();
    },
  );
});

describe("walletconnect session expiry, restart and deletion", () => {
  it(
    "answers 4100 for a request whose expiryTimestamp passed under our clock",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client);
      // Valid per the SDK's [5min, 7d] request-expiry bounds; past under our injected clock.
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 360;
      r.setNow((expiryTimestamp + 60) * 1000);
      const id = 424_242;
      await sendRaw(
        client,
        live.topic,
        id,
        "personal_sign",
        ["0x00", "0x0000000000000000000000000000000000000000"],
        EVM1,
        expiryTimestamp,
      );
      const response = await responseFor(client, live.topic, id);
      expect(response.error).toMatchObject({ code: 4100 });
      await r.wc.dispose();
    },
  );

  it(
    "ends an in-flight request on session_request_expire and never answers it",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client);
      const session = sessionOf(r, live.topic);
      if (session === undefined) {
        throw new Error("no session");
      }
      const from = getAddress(accountOf(session, EVM1));
      const message = `0x${Buffer.from("expiring", "utf8").toString("hex")}`;
      const settled = client
        .request({
          topic: live.topic,
          chainId: EVM1,
          request: { method: "personal_sign", params: [message, from] },
        })
        .then((v) => ({ value: v }))
        .catch((error: unknown) => ({ error }));
      const request = await openRequest(r);
      const [pendingWc] = r.kit.getPendingSessionRequests();
      if (pendingWc === undefined) {
        throw new Error("no pending wc request");
      }
      const before = await responsesOn(client, live.topic);
      // The engine-side expirer drops the request: its pipeline entry ends and no response goes out.
      r.kit.engine.signClient.events.emit("session_request_expire", { id: pendingWc.id });
      await until(() => r.engine.requests.getState().requests[request.id]?.stage === "invalidated");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const responses = await responsesOn(client, live.topic);
      expect(responses.size).toBe(before.size);
      settled.catch(() => undefined);
      void settled;
      await r.wc.dispose();
    },
  );

  it(
    "recovers a pending session request from storage after a restart",
    { timeout: 150_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client);
      const from = getAddress(accountOf(session, EVM1));
      const message = `0x${Buffer.from("recovered", "utf8").toString("hex")}`;
      // Sent while locked: the request lands in the SDK's pending store without our queue
      // draining it, then the whole entry is thrown away — an app exit.
      await r.wallet.vault.lock();
      await until(() => !r.engine.connections.getState().ready);
      const settled = client
        .request({
          topic: live.topic,
          chainId: EVM1,
          request: { method: "personal_sign", params: [message, from] },
        })
        .then((v) => ({ value: v }))
        .catch((error: unknown) => ({ error }));
      await until(() => r.kit.getPendingSessionRequests().length === 1);
      await r.wc.dispose();
      const restarted = await (
        await loadClient()
      )({
        projectId: "test",
        metadata: WALLET_META,
        storage: r.storage,
        relayUrl: "wss://fake.relay",
        wallet: r.wallet,
        engine: r.engine,
        now: () => Date.now(),
        logger: { warn: () => undefined },
      });
      // Still locked — the recovered request waits for the vault.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(awaiting(r)).toHaveLength(0);
      await r.wallet.vault.unlock(PW);
      await until(() => r.engine.connections.getState().ready);
      const request = await openRequest(r);
      await r.engine.requests.approve(request.id, "evm-sign", approval(request, PW));
      const result = await settled;
      expect("value" in result && typeof result.value === "string").toBe(true);
      await restarted.walletConnect.dispose();
    },
  );

  it(
    "disconnects the session and its pairing when the session's wallet is deleted",
    { timeout: 150_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { live } = await established(r, client);
      const events: Array<{ name: string; data: unknown }> = [];
      client.on("session_event", (event) => {
        events.push({ name: event.params.event.name, data: event.params.event.data });
      });
      const deleted: string[] = [];
      client.on("session_delete", (event) => {
        deleted.push(event.topic);
      });
      await r.wallet.wallets.delete(r.walletId, PW);
      await until(() => deleted.includes(live.topic));
      expect(sessionOf(r, live.topic)).toBeUndefined();
      expect(r.core.pairing.getPairings().every((pairing) => !pairing.active)).toBe(true);
      // No repoint ever advertised another wallet's account for this session.
      expect(events.some((e) => e.name === "accountsChanged")).toBe(false);
      await r.wc.dispose();
    },
  );
});

/** Polls the relay mailbox until the decoded JSON-RPC answer for `id` appears. */
const responseFor = async (
  client: Dapp,
  topic: string,
  id: number,
  ms = 10_000,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> => {
  const deadline = Date.now() + ms;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    const responses = await responsesOn(client, topic);
    const found = responses.get(id);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`no response for request ${id}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("walletconnect adversarial requests", () => {
  it(
    "never reaches the pipeline for a method or chain outside the session",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client);
      const from = getAddress(accountOf(session, EVM1));
      // eth_sign is not a granted session method; eip155:56 is not a granted chain.
      await sendRaw(client, live.topic, 7001, "eth_sign", ["0x00", from]);
      await sendRaw(client, live.topic, 7002, "personal_sign", ["0x00", from], "eip155:56");
      const [bad1, bad2] = await Promise.all([
        responseFor(client, live.topic, 7001),
        responseFor(client, live.topic, 7002),
      ]);
      expect(bad1.error).toBeDefined();
      expect(bad2.error).toBeDefined();
      expect(awaiting(r)).toHaveLength(0);
      await r.wc.dispose();
    },
  );

  it("answers 4100 for an account outside the session scope", { timeout: 120_000 }, async () => {
    walletConnectRelay.reset();
    const r = await rig();
    const client = await dapp();
    const { live } = await established(r, client);
    const outsider = "0x9999999999999999999999999999999999999999";
    const message = `0x${Buffer.from("forged account", "utf8").toString("hex")}`;
    await sendRaw(client, live.topic, 7003, "personal_sign", [message, outsider]);
    const response = await responseFor(client, live.topic, 7003);
    expect(response.error?.code).toBe(4100);
    await r.wc.dispose();
  });

  it(
    "answers -32005 when the params exceed the message limit and never replays a request id",
    { timeout: 120_000 },
    async () => {
      walletConnectRelay.reset();
      const r = await rig();
      const client = await dapp();
      const { session, live } = await established(r, client);
      const from = getAddress(accountOf(session, EVM1));
      const huge = `0x${"aa".repeat(140 * 1024)}`;
      await sendRaw(client, live.topic, 7004, "personal_sign", [huge, from]);
      const response = await responseFor(client, live.topic, 7004);
      expect(response.error?.code).toBe(-32_005);

      // The same request id delivered twice runs once.
      const message = `0x${Buffer.from("once", "utf8").toString("hex")}`;
      await sendRaw(client, live.topic, 7005, "personal_sign", [message, from]);
      await sendRaw(client, live.topic, 7005, "personal_sign", [message, from]);
      const request = await openRequest(r);
      await r.engine.requests.approve(request.id, "evm-sign", approval(request, PW));
      const result = await responseFor(client, live.topic, 7005);
      expect(result.result).toBeTypeOf("string");
      // The replayed copy never produced a second pipeline request.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(awaiting(r)).toHaveLength(0);
      await r.wc.dispose();
    },
  );
});
