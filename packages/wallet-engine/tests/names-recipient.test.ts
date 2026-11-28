// oxlint-disable vitest/no-conditional-in-test -- the scripted endpoints answer by method and URL
import { base58, base64 } from "@scure/base";
import { getAddressEncoder, address } from "@solana/kit";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import { PROGRAM_IDS, associatedTokenAddress } from "@qntx/wallet-chains/solana";
import type { chains } from "@qntx/wallet/chains";

import { UNIVERSAL_RESOLVER } from "../src/names/ens.ts";
import { SNS_NAME_PROGRAM, SNS_ROOT_DOMAIN, snsDomainKey } from "../src/names/sns.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { AccountRef } from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import {
  bookDeps,
  fakeSignedEvm,
  idleNetworkDeps,
  simulateSolanaStub,
  simulateV1Result,
  tokensStub,
} from "./send-helpers.ts";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const VERIFY = { kind: "password" as const, password: "pw" };
const GATEWAY = "https://gw.test";
const HOST = "https://host.test";

/** A `resolveWithGateways` result whose inner `addr` decodes to `address` for any coin type. */
const ensResult = (ensAddress: string): string =>
  encodeAbiParameters(parseAbiParameters("bytes, bytes"), [
    encodeAbiParameters(parseAbiParameters("bytes"), [ensAddress as `0x${string}`]),
    "0x",
  ]);

const EVM_NET = "eip155:11155111";
const EVM_ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44",
};
const SENDER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TARGET = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_TARGET = "0x2222222222222222222222222222222222222222";
const NFT_CONTRACT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

type EvmOptions = {
  readonly nft?: boolean;
  readonly mutableEns?: { current: string | undefined };
};

const evmWorld = (options: EvmOptions = {}) => {
  const mutable = options.mutableEns ?? { current: ensResult(TARGET) };
  const signedRequests: unknown[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: [EVM_NET] });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method?: string;
      params?: unknown[];
    };
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    if (body.method === "eth_call") {
      const call = (body.params?.[0] ?? {}) as { to?: string; data?: string };
      if ((call.to ?? "").toLowerCase() === UNIVERSAL_RESOLVER) {
        return mutable.current === undefined
          ? Response.json({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32_000, message: "resolver unavailable" },
            })
          : reply(mutable.current);
      }
      const data = (call.data ?? "").toLowerCase();
      if (options.nft === true) {
        if (data.startsWith("0x01ffc9a7")) {
          const interfaceId = data.slice(10, 18);
          return reply(`0x${(interfaceId === "80ac58cd" ? 1 : 0).toString(16).padStart(64, "0")}`);
        }
        if (data.startsWith("0x6352211e")) {
          return reply(`0x${"0".repeat(24)}${SENDER.slice(2).toLowerCase()}`);
        }
      }
      return reply(`0x${"00".repeat(32)}`);
    }
    if (body.method === "eth_simulateV1") {
      return reply(simulateV1Result(body.params));
    }
    const base: Record<string, unknown> = {
      eth_chainId: "0xaa36a7",
      eth_blockNumber: "0x1",
      eth_getTransactionCount: "0x0",
      eth_estimateGas: "0x5208",
      eth_feeHistory: { baseFeePerGas: ["0x64", "0x64"], reward: [["0x1", "0x1", "0x1"]] },
      eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
      eth_getTransactionReceipt: {
        status: "0x1",
        blockNumber: "0x1",
        blockHash: `0x${"11".repeat(32)}`,
      },
      eth_getBlockByNumber: { number: "0x2" },
      eth_getCode: "0x",
    };
    return body.method !== undefined && body.method in base
      ? reply(base[body.method])
      : Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: `method not found: ${body.method ?? ""}` },
        });
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [EVM_NET]: [HOST] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway: {
      url: GATEWAY,
      clientIds: {
        evm: "a".repeat(32),
        solana: "a".repeat(32),
        bitcoin: "a".repeat(32),
        tron: "a".repeat(32),
        service: "a".repeat(32),
      },
    },
  });
  const apis = {
    account: async () =>
      Promise.resolve({ template: "evm.bip44", network: EVM_NET, address: SENDER }),
    sign: async ({ request }: { request: SignRequest }) => {
      signedRequests.push(request);
      return Promise.resolve(fakeSignedEvm(request));
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
    now: () => 0,
    logger,
    pollMs: 1,
    chains: apis,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: fetchImpl,
    random: (n) => new Uint8Array(n).fill(4),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  return {
    requests,
    transactions,
    mutable,
    signedRequests,
    start: async () => {
      await networks.init();
      await transactions.init();
      await requests.init();
    },
  };
};

const prepareEvmSend = async (w: ReturnType<typeof evmWorld>, to: string) =>
  w.requests.prepare({
    method: "send",
    account: EVM_ACCOUNT,
    network: EVM_NET,
    to,
    amount: 1_000_000_000_000_000n,
    fee: "normal",
  });

describe("named recipients on EVM sends", () => {
  it("names the display outflow and merges resolution checks and unicode risk", async () => {
    const w = evmWorld();
    await w.start();
    const request = await prepareEvmSend(w, "café.eth");
    const flow = "outflows" in request.display ? request.display.outflows[0] : undefined;
    expect(flow?.to.toLowerCase()).toBe(TARGET);
    expect(flow?.name).toBe("café.eth");
    expect(request.checks).toStrictEqual([]);
    expect(request.risk).toContainEqual({ code: "name-unicode", level: "warning" });
  });

  it("requires acknowledgement of a mixed-script recipient name", async () => {
    const w = evmWorld();
    await w.start();
    const request = await prepareEvmSend(w, "ξχ.д.eth");
    expect(request.risk).toContainEqual({ code: "name-mixed-script", level: "danger" });
    await expect(w.requests.approve(request.id, "send", { verify: VERIFY })).rejects.toMatchObject({
      name: "AcknowledgementRequiredError",
    });
    const tx = await w.requests.approve(request.id, "send", approval(request, VERIFY));
    expect(tx.state).toBeDefined();
    expect(w.signedRequests).toHaveLength(1);
  });

  it("signs when approval-time resolution is unchanged", async () => {
    const w = evmWorld();
    await w.start();
    const request = await prepareEvmSend(w, "name.eth");
    await w.requests.approve(request.id, "send", approval(request, VERIFY));
    expect(w.signedRequests).toHaveLength(1);
  });

  it("fails before signing when approval-time resolution changes", async () => {
    const mutable = { current: ensResult(TARGET) };
    const w = evmWorld({ mutableEns: mutable });
    await w.start();
    const request = await prepareEvmSend(w, "name.eth");
    mutable.current = ensResult(OTHER_TARGET);
    await expect(w.requests.approve(request.id, "send", approval(request, VERIFY))).rejects.toThrow(
      `name.eth now resolves to ${OTHER_TARGET}, not ${TARGET}`,
    );
    expect(w.requests.getState().requests[request.id]?.stage).toBe("failed");
    expect(w.signedRequests).toHaveLength(0);
  });

  it("fails before signing when approval-time resolution fails", async () => {
    const mutable = { current: ensResult(TARGET) as string | undefined };
    const w = evmWorld({ mutableEns: mutable });
    await w.start();
    const request = await prepareEvmSend(w, "name.eth");
    mutable.current = undefined;
    await expect(w.requests.approve(request.id, "send", approval(request, VERIFY))).rejects.toThrow(
      "name.eth no longer resolves safely",
    );
    expect(w.requests.getState().requests[request.id]?.stage).toBe("failed");
    expect(w.signedRequests).toHaveLength(0);
  });

  it("names an NFT outflow and enforces re-resolution for evm-nft-send", async () => {
    const mutable = { current: ensResult(TARGET) };
    const w = evmWorld({ nft: true, mutableEns: mutable });
    await w.start();
    const input = {
      method: "evm-nft-send" as const,
      account: EVM_ACCOUNT,
      network: EVM_NET,
      contract: NFT_CONTRACT,
      items: [{ tokenId: 7n }],
      to: "name.eth",
      fee: "normal" as const,
    };
    const request = await w.requests.prepare(input);
    const flow = "outflows" in request.display ? request.display.outflows[0] : undefined;
    expect(flow?.to.toLowerCase()).toBe(TARGET);
    expect(flow?.name).toBe("name.eth");
    mutable.current = ensResult(OTHER_TARGET);
    await expect(
      w.requests.approve(request.id, "evm-nft-send", approval(request, VERIFY)),
    ).rejects.toThrow("now resolves");
    expect(w.signedRequests).toHaveLength(0);
  });
});

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change",
};
const PAYER = "HAgk14Jp9U1Y6YV7Qe8rJx9c4kXvF4w7Yf5tP2nY5K1n";
const SOL_TARGET = "9Xx76WpEjfwhvuTcXiXBHgVPzXsJ8aAaSBTLjdFyf9DL";
const SOL_OTHER = "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const encoder = getAddressEncoder();
const bytesOf = (value: string): Uint8Array => new Uint8Array(encoder.encode(address(value)));

const registryBytes = (owner: string): Uint8Array => {
  const out = new Uint8Array(96);
  out.set(bytesOf(SNS_ROOT_DOMAIN), 0);
  out.set(bytesOf(owner), 32);
  return out;
};

const accountValue = (owner: string, data: Uint8Array, lamports = 1_500_000): unknown => ({
  owner,
  data: [base64.encode(data), "base64"],
  lamports,
  executable: false,
  rentEpoch: 0,
});

const snsAccounts = async (owner: string): Promise<Map<string, Uint8Array>> => {
  const key = await snsDomainKey("example");
  return new Map([[key, registryBytes(owner)]]);
};

const solanaWorld = (accounts: Map<string, Uint8Array>) => {
  const signedRequests: unknown[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: [SOL_NET] });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method?: string;
      params?: unknown[];
    };
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    const rawAccount = (key: string): unknown => {
      const data = accounts.get(key);
      if (data !== undefined) {
        return accountValue(SNS_NAME_PROGRAM, data);
      }
      if (key === PAYER) {
        return accountValue("11111111111111111111111111111111", new Uint8Array(), 50_000_000_000);
      }
      return null;
    };
    switch (body.method) {
      case "getAccountInfo": {
        const key = String(body.params?.[0] ?? "");
        if (key === MINT) {
          const mint = new Uint8Array(82);
          mint[45] = 1;
          return reply({ value: accountValue(PROGRAM_IDS.token, mint) });
        }
        return reply({ value: rawAccount(key) });
      }
      case "getMultipleAccounts": {
        const keys = (body.params?.[0] as string[] | undefined) ?? [];
        return reply({ value: keys.map((key) => rawAccount(key)) });
      }
      case "getLatestBlockhash":
        return reply({
          value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100_000 },
        });
      case "simulateTransaction": {
        const addresses =
          (body.params?.[1] as { accounts?: { addresses?: string[] } } | undefined)?.accounts
            ?.addresses ?? [];
        return reply({
          value: {
            err: null,
            logs: [],
            unitsConsumed: 21_000,
            accounts: addresses.map((key) => rawAccount(key)),
          },
        });
      }
      case "getRecentPrioritizationFees":
        return reply([]);
      case "getGenesisHash":
        return reply("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      case "isBlockhashValid":
        return reply({ context: { slot: 5000 }, value: true });
      case "sendTransaction":
        return reply(base58.encode(new Uint8Array(64).fill(7)));
      case "getSignatureStatuses":
        return reply({ value: [{ confirmationStatus: "finalized", err: null }] });
      case "getBlockHeight":
        return reply(1);
      default:
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32_000, message: `unexpected ${body.method ?? ""}` },
        });
    }
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [SOL_NET]: [HOST] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway: {
      url: GATEWAY,
      clientIds: {
        evm: "a".repeat(32),
        solana: "a".repeat(32),
        bitcoin: "a".repeat(32),
        tron: "a".repeat(32),
        service: "a".repeat(32),
      },
    },
  });
  const apis = {
    account: async () =>
      Promise.resolve({ template: "solana.bip44-change", network: SOL_NET, address: PAYER }),
    sign: async ({ request }: { request: SignRequest }) => {
      signedRequests.push(request);
      return Promise.resolve({ kind: "solana.transaction", signature: new Uint8Array(64) });
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
    now: () => 0,
    logger,
    pollMs: 1,
    chains: apis,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: fetchImpl,
    random: (n) => new Uint8Array(n).fill(4),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  return {
    requests,
    transactions,
    signedRequests,
    start: async () => {
      await networks.init();
      await transactions.init();
      await requests.init();
    },
  };
};

const prepareSplSend = async (w: ReturnType<typeof solanaWorld>, to: string) =>
  w.requests.prepare({
    method: "send",
    account: SOL_ACCOUNT,
    network: SOL_NET,
    to,
    amount: 1n,
    token: MINT,
    decimals: 0,
    fee: "normal",
  });

describe("named recipients on Solana sends", () => {
  it("names the associated-token-account outflow of an SPL send", async () => {
    const accounts = await snsAccounts(SOL_TARGET);
    const w = solanaWorld(accounts);
    await w.start();
    const request = await prepareSplSend(w, "example.sns");
    expect(request.display).toMatchObject({
      outflows: [
        {
          to: associatedTokenAddress(SOL_TARGET, MINT, PROGRAM_IDS.token),
          name: "example.sns",
        },
      ],
    });
  });

  it("fails before signing when Solana re-resolution changes", async () => {
    const accounts = await snsAccounts(SOL_TARGET);
    const w = solanaWorld(accounts);
    await w.start();
    const request = await prepareSplSend(w, "example.sns");
    const key = await snsDomainKey("example");
    accounts.set(key, registryBytes(SOL_OTHER));
    await expect(w.requests.approve(request.id, "send", approval(request, VERIFY))).rejects.toThrow(
      `example.sns now resolves to ${SOL_OTHER}, not ${SOL_TARGET}`,
    );
    expect(w.requests.getState().requests[request.id]?.stage).toBe("failed");
    expect(w.signedRequests).toHaveLength(0);
  });

  it("refuses a legacy .sol recipient at prepare", async () => {
    const w = solanaWorld(await snsAccounts(SOL_TARGET));
    await w.start();
    await expect(prepareSplSend(w, "example.sol")).rejects.toThrow("SRS migration");
    expect(w.signedRequests).toHaveLength(0);
  });
});

describe("families without a name service", () => {
  it.each([
    { network: "bip122:000000000019d6689c085ae165831e93", family: "bitcoin" },
    { network: "tron:728126428", family: "tron" },
  ])("refuses a dotted recipient on $family at prepare", async ({ network, family }) => {
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: globalThis.fetch,
      rpc: {},
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger,
    });
    const transactions = new TransactionController({
      wallet: {} as Wallet,
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (n) => new Uint8Array(n).fill(3),
      setTimer: () => () => undefined,
      now: () => 0,
      logger,
      pollMs: 1,
      chains: {} as ReturnType<typeof chains>,
    });
    await transactions.init();
    await expect(
      transactions.prepareSend(
        {
          account:
            family === "bitcoin"
              ? { kind: "hd", walletId: "w", groupIndex: 0, template: "btc.bip84" }
              : { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" },
          network,
          to: "name.example",
          amount: 1n,
          fee: "normal",
        },
        "req-names",
      ),
    ).rejects.toThrow(`names are not supported on ${family} networks`);
  });
});
