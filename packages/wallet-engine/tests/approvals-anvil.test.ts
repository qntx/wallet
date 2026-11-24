/**
 * Anvil e2e for the approvals inventory and revocation: a real node wallet, kernel signing and the
 * full request pipeline against a live chain (hardfork prague, chain id 1 — the 7702 flow needs
 * it). A fake gateway injects approval candidates — true and invented; every row the view shows is
 * confirmed by chain reads, so invented keys must only add to `dropped`. Revocation goes through
 * `ApprovalsController.revoke`/`revokeBatch` → `requests.approve` → broadcast → confirmed; each
 * mined approval-bearing request re-reads the view through the confirmed-transaction subscription.
 * Gated on `ENGINE_E2E_ANVIL=1` like the other anvil files.
 */
import { execFile, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { EVM_DELEGATOR } from "@qntx/wallet-chains/evm";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { ApprovalsController } from "../src/approvals/controller.ts";
import type { ApprovalRow, ApprovalsView } from "../src/approvals/types.ts";
import type { EngineLogger } from "../src/events.ts";
import type { GatewayScope } from "../src/gateway/session.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { PendingRequest } from "../src/requests/controller.ts";
import type { ChainRequestMethod } from "../src/requests/types.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { AccountRef, TrackedTransaction } from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import { idleNetworkDeps, requestsFor } from "./send-helpers.ts";

const RUN = process.env["ENGINE_E2E_ANVIL"] === "1";
const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const NETWORK = "eip155:1";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

/*
 * Permit2 runtime fixture provenance: fetched once with
 *   eth_getCode(0x000000000022D473030F116dDEE9F6B43aC78BA3, 26475742)
 * from https://ethereum-rpc.publicnode.com on 2026-11-23.
 * keccak256 = 0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131
 */
const PERMIT2_CODE_HASH = "0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131";
const PERMIT2_CODE = readFileSync(
  new URL("fixtures/permit2-runtime.hex", import.meta.url).pathname,
  "utf8",
).trim() as Hex;
const DELEGATOR_CODE = readFileSync(
  new URL("fixtures/eip7702-stateless-delegator-1.3.0.hex", import.meta.url).pathname,
  "utf8",
).trim() as Hex;

const PERMIT2_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

const anvil = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/anvil`;
  return existsSync(local) ? local : execFileSync("which", ["anvil"]).toString().trim();
};
const forge = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/forge`;
  return existsSync(local) ? local : execFileSync("which", ["forge"]).toString().trim();
};

const rpcCall = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) {
    throw new Error(`${method}: ${body.error.message}`);
  }
  return body.result;
};

const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const realTimer = (ms: number, fn: () => unknown): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => {
    clearTimeout(id);
  };
};

const waitUntil = async (
  check: () => boolean | Promise<boolean>,
  deadline = Date.now() + 20_000,
  describe?: () => string,
): Promise<void> => {
  if (await check()) {
    return;
  }
  if (Date.now() >= deadline) {
    const state = describe === undefined ? "" : ` — last state: ${describe()}`;
    throw new Error(`waitUntil timed out${state}`);
  }
  await sleep(150);
  return waitUntil(check, deadline, describe);
};

/** Anvil takes a moment to bind its port on a loaded machine — wait for a real JSON-RPC answer. */
const rpcReady = async (url: string): Promise<boolean> => {
  try {
    await rpcCall(url, "eth_blockNumber", []);
    return true;
  } catch {
    return false;
  }
};

const anvilLogger: EngineLogger = { warn: () => {} };

const taggedRandom = (): ((n: number) => Uint8Array) => {
  let tag = 0;
  return (n) => {
    tag += 1;
    return new Uint8Array(n).fill(tag);
  };
};

const compile = (
  file: string,
  contract: string,
): { bytecode: Hex; abi: ReadonlyArray<unknown> } => {
  const dir = mkdtempSync(join(tmpdir(), "approvals-anvil-"));
  try {
    execFileSync("mkdir", [join(dir, "src")]);
    execFileSync("cp", [join(import.meta.dirname, `fixtures/${file}.sol`), join(dir, "src")]);
    execFileSync(forge(), ["build", "--root", dir, "--quiet"]);
    const artifact = JSON.parse(
      readFileSync(join(dir, `out/${file}.sol/${contract}.json`), "utf8"),
    ) as { bytecode: { object: string }; abi: unknown[] };
    return { bytecode: artifact.bytecode.object as Hex, abi: artifact.abi };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const realWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
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
  const info = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: { kind: "password", password: PASSWORD },
  });
  return { wallet, walletId: info.walletId };
};

const randomEoa = (): Address => `0x${randomBytes(20).toString("hex")}`;

/** Mutable fake-gateway answer; the test rewrites `candidates` between loads. */
const gatewayAnswer = { candidates: [] as ReadonlyArray<Record<string, unknown>> };

const fakeFetch =
  (url: string): typeof globalThis.fetch =>
  async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target.startsWith("https://approvals.test/v1/approvals/")) {
      const toBlock = await rpcCall(url, "eth_blockNumber", []);
      return Response.json({
        toBlock: BigInt(toBlock as string).toString(10),
        candidates: gatewayAnswer.candidates,
        truncated: false,
      });
    }
    return fetch(input, init);
  };

const GATEWAY = {
  url: "https://approvals.test",
  clientIds: {
    evm: "e2e-evm",
    solana: "e2e-solana",
    bitcoin: "e2e-bitcoin",
    tron: "e2e-tron",
    service: "e2e-service",
  } as Record<GatewayScope, string>,
};

type RowPred = (r: ApprovalRow) => boolean;

const erc20Row =
  (spender: string): RowPred =>
  (r) =>
    r.kind === "erc20" && r.spender.toLowerCase() === spender;

const operatorRow =
  (contract: string, operator: string): RowPred =>
  (r) =>
    r.kind === "operator" &&
    r.contract.toLowerCase() === contract.toLowerCase() &&
    r.operator.toLowerCase() === operator;

/* The chain read answers checksummed; compare the spender case-insensitively. */
const nftRow =
  (spender: string, tokenId: bigint): RowPred =>
  (r) =>
    r.kind === "nft" && r.spender.toLowerCase() === spender && r.tokenId === tokenId.toString(10);

const findRow = (v: ApprovalsView, pred: RowPred): ApprovalRow | undefined => v.rows.find(pred);

const idOf = (v: ApprovalsView, pred: RowPred): string => {
  const found = findRow(v, pred);
  if (found === undefined) {
    throw new Error("expected row missing from the view");
  }
  return found.id;
};

const heightOf = (v: ApprovalsView): string => {
  if (v.at === undefined) {
    throw new Error("view carries no read height");
  }
  return v.at.height;
};

const firstApproval = (p: PendingRequest): Record<string, unknown> => {
  const { display } = p;
  const [entry] = "approvals" in display ? display.approvals : [];
  if (entry === undefined) {
    throw new Error("the pending request's display names no approval change");
  }
  return entry;
};

const hashOf = (sent: TrackedTransaction): Hex => {
  if (sent.hash === undefined) {
    throw new Error("approved request left no transaction hash");
  }
  return sent.hash as Hex;
};

/** The call count inside a batch intent — an authorization would not decode as a batch at all. */
const intentCalls = (tx: TrackedTransaction): number =>
  tx.intent === undefined ? 0 : (tx.intent.calls ?? []).length;

const contractAddress = (value: string | null | undefined): Address => {
  if (value === null || value === undefined) {
    throw new Error("deploy did not return a contract address");
  }
  return value as Address;
};

describe.runIf(RUN)("anvil e2e: approvals inventory and revocation", () => {
  const port = 18580;
  const url = `http://127.0.0.1:${port}`;

  let proc: ChildProcess;
  let wallet: Wallet;
  let acct: AccountRef;
  let from: Address;
  let client: PublicClient;
  let transactions: TransactionController;
  let approvals: ApprovalsController;
  let commit: (pending: PendingRequest) => Promise<TrackedTransaction>;
  let key: string;
  let token: Address;
  let collectibles: Address;
  let multi: Address;
  let tokenAbi: ReadonlyArray<unknown>;
  let collectiblesAbi: ReadonlyArray<unknown>;
  let multiAbi: ReadonlyArray<unknown>;

  const SPENDER_A = randomEoa();
  const SPENDER_B = randomEoa();
  const OPERATOR_C = randomEoa();
  const SPENDER_D = randomEoa();
  const OPERATOR_E = randomEoa();
  const TOKEN_ID = 7n;

  const view = (): ApprovalsView => {
    const found = approvals.getState().views[key];
    if (found === undefined) {
      throw new Error(`view ${key} not loaded`);
    }
    return found;
  };
  /** The view's failure shape for a timed-out wait: status/error, read height, counters, rows. */
  const describeView = (): string => {
    const v = view();
    const rows = v.rows.map((r) => r.id).join(", ");
    const sources = v.sources.map((s) => `${s.source}:${s.status}`).join(", ");
    return (
      `status=${v.status} error=${v.error ?? "-"} at=${v.at?.height ?? "-"} ` +
      `dropped=${v.dropped} disputed=${v.disputed} unread=${v.unread} unverified=${v.unverified} ` +
      `sources=[${sources}] rows=[${rows}]`
    );
  };
  const hasRow = (pred: RowPred): boolean => findRow(view(), pred) !== undefined;
  const rowSourced = (pred: RowPred): boolean => {
    const found = findRow(view(), pred);
    return found !== undefined && found.sources.includes("local");
  };

  const deploy = async (
    artifact: { bytecode: Hex; abi: ReadonlyArray<unknown> },
    args: ReadonlyArray<unknown>,
  ): Promise<Address> => {
    const walletClient = createWalletClient({ chain: mainnet, transport: http(url) });
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
      account: from,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    return contractAddress(receipt.contractAddress);
  };

  /** A contract call from the wallet's own address while it is impersonated (setup only). */
  const setupCall = async (
    address: Address,
    abi: ReadonlyArray<unknown>,
    functionName: string,
    args: ReadonlyArray<unknown>,
  ): Promise<void> => {
    const walletClient = createWalletClient({ chain: mainnet, transport: http(url) });
    const hash = await walletClient.writeContract({
      address,
      abi,
      functionName,
      args,
      account: from,
    });
    await client.waitForTransactionReceipt({ hash });
  };

  const block = async (): Promise<bigint> =>
    BigInt((await rpcCall(url, "eth_blockNumber", [])) as string);

  const allowanceRead = async (spender: Address): Promise<bigint> =>
    (await client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "allowance",
      args: [from, spender],
    })) as bigint;

  const permit2Read = async (spender: Address): Promise<bigint> => {
    const read = await client.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: "allowance",
      args: [from, token, spender],
    });
    return read[0];
  };

  const approvedForAll = async (
    contract: Address,
    abi: ReadonlyArray<unknown>,
    operator: Address,
  ): Promise<boolean> =>
    (await client.readContract({
      address: contract,
      abi,
      functionName: "isApprovedForAll",
      args: [from, operator],
    })) as boolean;

  const getApproved = async (tokenId: bigint): Promise<string> =>
    (await client.readContract({
      address: collectibles,
      abi: collectiblesAbi,
      functionName: "getApproved",
      args: [tokenId],
    })) as string;

  /** The row must vanish once the confirmed-transaction subscription re-reads the view. */
  const expectRowGone = async (pred: RowPred): Promise<void> =>
    waitUntil(() => !hasRow(pred), Date.now() + 30_000, describeView);

  beforeAll(async () => {
    if (keccak256(PERMIT2_CODE) !== PERMIT2_CODE_HASH) {
      throw new Error("the pinned Permit2 runtime fixture no longer matches its recorded hash");
    }
    proc = execFile(anvil(), [
      "--port",
      String(port),
      "--silent",
      "--chain-id",
      "1",
      "--hardfork",
      "prague",
    ]);
    await waitUntil(
      async () => rpcReady(url),
      Date.now() + 20_000,
      () => "anvil never answered eth_blockNumber",
    );
    client = createPublicClient({ transport: http(url) });

    const { wallet: node, walletId } = await realWallet();
    wallet = node;
    acct = {
      kind: "hd",
      walletId,
      groupIndex: 0,
      template: "evm.bip44",
    };
    const evmAccount = await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "evm.bip44",
      network: NETWORK,
    });
    from = ("address" in evmAccount ? evmAccount.address : "") as Address;

    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: globalThis.fetch.bind(globalThis),
      rpc: { [NETWORK]: [url] },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: anvilLogger,
    });
    transactions = new TransactionController({
      wallet,
      chains: chains(wallet),
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: taggedRandom(),
      setTimer: realTimer,
      now: () => Date.now(),
      logger: anvilLogger,
      pollMs: 50,
    });
    await transactions.init();
    const requests = await requestsFor(transactions);
    commit = async (pending) => {
      const sent = await requests.approve(
        pending.id,
        pending.method as ChainRequestMethod,
        approval(pending, VERIFY),
      );
      const receipt = await client.waitForTransactionReceipt({ hash: hashOf(sent) });
      if (receipt.status !== "success") {
        throw new Error(`request transaction ${receipt.transactionHash} reverted`);
      }
      return sent;
    };
    approvals = new ApprovalsController({
      networks,
      transactions,
      gateway: GATEWAY,
      fetch: fakeFetch(url),
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: realTimer,
      now: () => Date.now(),
      logger: anvilLogger,
      addressOf: async (account, network) => transactions.addressOf(account, network),
      known: () => [],
      tokenMetadata: async () => Promise.resolve({ symbol: "TST", decimals: 18 }),
      sessions: async () => Promise.resolve([]),
      prepare: async (input) => requests.prepare(input),
    });
    await approvals.init();

    /* Chain state, all written as the wallet's own account through impersonation. */
    await rpcCall(url, "anvil_setBalance", [from, "0x3635c9adc5dea00000"]);
    await rpcCall(url, "anvil_setCode", [PERMIT2, PERMIT2_CODE]);
    await rpcCall(url, "anvil_setCode", [EVM_DELEGATOR.address, DELEGATOR_CODE]);
    await rpcCall(url, "anvil_impersonateAccount", [from]);

    const tokenArtifact = compile("TestToken", "TestToken");
    tokenAbi = tokenArtifact.abi;
    token = await deploy(tokenArtifact, [1_000_000n * 10n ** 18n]);
    const nftArtifact = compile("TestCollectibles", "TestCollectibles");
    collectiblesAbi = nftArtifact.abi;
    collectibles = await deploy(nftArtifact, []);
    const multiArtifact = compile("TestCollectibles", "TestMulti");
    multiAbi = multiArtifact.abi;
    multi = await deploy(multiArtifact, []);

    await setupCall(collectibles, collectiblesAbi, "mint", [from, TOKEN_ID]);
    await setupCall(multi, multiAbi, "mint", [from, 1n, 100n]);
    const MAX = 2n ** 256n - 1n;
    await setupCall(token, tokenAbi, "approve", [SPENDER_A, MAX]);
    await setupCall(token, tokenAbi, "approve", [PERMIT2, MAX]);
    const future = Math.floor(Date.now() / 1000) + 3600;
    await setupCall(PERMIT2, PERMIT2_ABI, "approve", [token, SPENDER_B, 1000n, future]);
    await setupCall(collectibles, collectiblesAbi, "setApprovalForAll", [OPERATOR_C, true]);
    await setupCall(collectibles, collectiblesAbi, "approve", [SPENDER_D, TOKEN_ID]);
    await setupCall(multi, multiAbi, "setApprovalForAll", [OPERATOR_E, true]);
    /* Live amount but a deadline already past — an expired Permit2 grant must not surface. */
    const past = Math.floor(Date.now() / 1000) - 60;
    await setupCall(PERMIT2, PERMIT2_ABI, "approve", [token, randomEoa(), 1000n, past]);
    await rpcCall(url, "anvil_stopImpersonatingAccount", [from]);

    const headHeight = await block();
    const head = headHeight.toString(10);
    gatewayAnswer.candidates = [
      { kind: "erc20", token, spender: SPENDER_A, block: head },
      { kind: "erc20", token, spender: PERMIT2, block: head },
      { kind: "permit2", token, spender: SPENDER_B, block: head },
      { kind: "operator", token: collectibles, operator: OPERATOR_C, block: head },
      {
        kind: "erc721",
        token: collectibles,
        spender: SPENDER_D,
        tokenId: TOKEN_ID.toString(10),
        block: head,
      },
      { kind: "operator", token: multi, operator: OPERATOR_E, block: head },
      { kind: "permit2", token, spender: randomEoa(), block: head },
      /* Invented: nothing on chain can confirm these. */
      { kind: "erc20", token, spender: randomEoa(), block: head },
      {
        kind: "erc721",
        token: collectibles,
        spender: randomEoa(),
        tokenId: "99",
        block: head,
      },
      { kind: "operator", token: multi, operator: randomEoa(), block: head },
    ];
  }, 300_000);

  afterAll(async () => {
    proc.kill();
    await wallet.destroy();
  });

  it("lists every live approval and counts the invented candidates as dropped", async () => {
    key = await approvals.load(acct, NETWORK);
    await waitUntil(() => view().status === "ready", Date.now() + 20_000, describeView);

    const listed = view();
    const liveHead = await block();
    expect(heightOf(listed)).toBe(liveHead.toString(10));
    expect(listed.sources).toContainEqual(
      expect.objectContaining({ source: "gateway", status: "ok" }),
    );
    expect(listed.dropped).toBe(4);

    expect(findRow(listed, erc20Row(SPENDER_A))).toMatchObject({
      kind: "erc20",
      spender: SPENDER_A,
      unlimited: true,
      risk: ["unlimited", "spender-no-code"],
    });
    expect(findRow(listed, (r) => r.kind === "permit2")).toMatchObject({
      kind: "permit2",
      spender: SPENDER_B,
      amount: "1000",
      unlimited: false,
      risk: ["spender-no-code"],
    });
    expect(findRow(listed, erc20Row(PERMIT2.toLowerCase()))).toMatchObject({
      kind: "erc20",
      unlimited: true,
    });
    expect(findRow(listed, operatorRow(collectibles, OPERATOR_C))).toBeDefined();
    expect(findRow(listed, operatorRow(multi, OPERATOR_E))).toBeDefined();
    expect(findRow(listed, nftRow(SPENDER_D, TOKEN_ID))).toBeDefined();
    expect(listed.rows).toHaveLength(6);
  }, 120_000);

  it("shows a tracked-request approval the gateway hides", async () => {
    const requests = await requestsFor(transactions);
    const spender = randomEoa();
    const pending = await requests.prepare({
      method: "evm-approve",
      account: acct,
      network: NETWORK,
      token,
      spender,
      amount: 42n,
      fee: "normal",
    });
    await commit(pending);
    /* The gateway's frozen candidate list never names this spender — local discovery must, and
     * the confirmed-transaction subscription refreshes the view once the send is in a block. */
    await waitUntil(() => rowSourced(erc20Row(spender)), Date.now() + 30_000, describeView);
    await expect(allowanceRead(spender)).resolves.toBe(42n);
  }, 120_000);

  it("revokes erc20, permit2, operators and the nft approval through the pipeline", async () => {
    const erc20 = await approvals.revoke(key, idOf(view(), erc20Row(SPENDER_A)));
    const erc20Shown = firstApproval(erc20);
    expect(erc20Shown["kind"]).toBe("allowance");
    expect(String(erc20Shown["spender"]).toLowerCase()).toBe(SPENDER_A);
    expect(erc20Shown["amount"]).toMatchObject({ amount: "0" });
    await commit(erc20);
    await expectRowGone(erc20Row(SPENDER_A));
    await expect(allowanceRead(SPENDER_A)).resolves.toBe(0n);

    const permit = await approvals.revoke(
      key,
      idOf(view(), (r) => r.kind === "permit2"),
    );
    const permitShown = firstApproval(permit);
    expect(permitShown["kind"]).toBe("allowance");
    expect(permitShown["via"]).toBe("permit2");
    expect(String(permitShown["spender"]).toLowerCase()).toBe(SPENDER_B);
    expect(permitShown["amount"]).toMatchObject({ amount: "0" });
    await commit(permit);
    await expectRowGone((r) => r.kind === "permit2");
    await expect(permit2Read(SPENDER_B)).resolves.toBe(0n);

    const op721 = await approvals.revoke(key, idOf(view(), operatorRow(collectibles, OPERATOR_C)));
    const opShown = firstApproval(op721);
    expect(opShown["kind"]).toBe("operator");
    expect(opShown["approved"]).toBe(false);
    expect(String(opShown["asset"]).toLowerCase()).toBe(collectibles.toLowerCase());
    expect(String(opShown["spender"]).toLowerCase()).toBe(OPERATOR_C);
    await commit(op721);
    await expectRowGone(operatorRow(collectibles, OPERATOR_C));
    await expect(approvedForAll(collectibles, collectiblesAbi, OPERATOR_C)).resolves.toBe(false);

    const op1155 = await approvals.revoke(key, idOf(view(), operatorRow(multi, OPERATOR_E)));
    await commit(op1155);
    await expectRowGone(operatorRow(multi, OPERATOR_E));
    await expect(approvedForAll(multi, multiAbi, OPERATOR_E)).resolves.toBe(false);

    const nft = await approvals.revoke(
      key,
      idOf(view(), (r) => r.kind === "nft"),
    );
    const nftShown = firstApproval(nft);
    expect(nftShown["kind"]).toBe("approval-cleared");
    expect(String(nftShown["asset"]).toLowerCase()).toBe(collectibles.toLowerCase());
    await commit(nft);
    await expectRowGone((r) => r.kind === "nft");
    const approved = await getApproved(TOKEN_ID);
    expect(approved.toLowerCase()).toBe("0x0000000000000000000000000000000000000000");
  }, 300_000);

  it("refuses a batch while undelegated, then batch-revokes under our 7702 delegation", async () => {
    const requests = await requestsFor(transactions);
    const g = randomEoa();
    const h = randomEoa();
    await rpcCall(url, "anvil_impersonateAccount", [from]);
    await setupCall(token, tokenAbi, "approve", [g, 10n]);
    await setupCall(token, tokenAbi, "approve", [h, 20n]);
    await rpcCall(url, "anvil_stopImpersonatingAccount", [from]);
    /* Raw impersonated approvals leave no tracked tx — the gateway scan would see the events. */
    const headHeight = await block();
    const head = headHeight.toString(10);
    gatewayAnswer.candidates = [
      ...gatewayAnswer.candidates,
      { kind: "erc20", token, spender: g, block: head },
      { kind: "erc20", token, spender: h, block: head },
    ];
    await approvals.refresh(key);
    await waitUntil(() => hasRow(erc20Row(g)), Date.now() + 20_000, describeView);
    await waitUntil(() => hasRow(erc20Row(h)), Date.now() + 20_000, describeView);

    const ids = [idOf(view(), erc20Row(g)), idOf(view(), erc20Row(h))];
    await expect(approvals.revokeBatch(key, ids)).rejects.toThrow(/delegated/);

    const upgrade = await requests.prepare({
      method: "evm-delegation",
      account: acct,
      network: NETWORK,
      action: "upgrade",
      fee: "normal",
    });
    await commit(upgrade);
    await waitUntil(
      () => hasRow((r) => r.kind === "delegation"),
      Date.now() + 30_000,
      describeView,
    );
    expect(findRow(view(), (r) => r.kind === "delegation")).toMatchObject({
      kind: "delegation",
      ours: true,
    });

    const batch = await approvals.revokeBatch(key, ids);
    const batchSent = await commit(batch);
    /* One transaction revoking both rows: a self-call batch decode, never an authorization. */
    expect(batchSent.intent).toMatchObject({ summary: "batch" });
    expect(intentCalls(batchSent)).toBe(2);
    await expectRowGone(erc20Row(g));
    await expectRowGone(erc20Row(h));
    await expect(allowanceRead(g)).resolves.toBe(0n);
    await expect(allowanceRead(h)).resolves.toBe(0n);

    const revokeDelegation = await approvals.revoke(
      key,
      idOf(view(), (r) => r.kind === "delegation"),
    );
    await commit(revokeDelegation);
    await expectRowGone((r) => r.kind === "delegation");
  }, 300_000);
});
