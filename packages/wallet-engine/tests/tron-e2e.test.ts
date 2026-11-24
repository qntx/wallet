/**
 * TRON devnet e2e — a TronBox Runtime Environment (`tronbox/tre`, HTTP on 9090, gated behind
 * `ENGINE_E2E_TRON=1`). A real wallet + kernel + engine against a live node: funding, the request
 * pipeline to solidified finality, a forge-compiled TRC-20, stake, an out-of-energy failure, expiry
 * ⇒ dropped, and local-only history (TRE serves no `/v1` indexer). Setup transactions (funding, the
 * deploys, the head ticks) sign with TRE's keys via `@qntx/wallet-chains/tron/sign` — test-only;
 * the wallet path never signs node-built bytes. TRE lazily mints one block per accepted
 * transaction, so the solidified head only advances while transactions land — waits for expiry tick
 * the head forward with setup transfers.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { TronWeb } from "tronweb";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import {
  buildTronRawData,
  decodeTron,
  decodeTronRawData,
  encodeTronTransaction,
  isTronAddress,
  tronAddressFromHex,
  tronAddressFromPublicKey,
  tronAddressToEvm,
  trc20TransferContract,
} from "@qntx/wallet-chains/tron";
import type { TronContract } from "@qntx/wallet-chains/tron";
import { signTronTransaction } from "@qntx/wallet-chains/tron/sign";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { ApprovalsController } from "../src/approvals/controller.ts";
import type { ApprovalsView } from "../src/approvals/types.ts";
import type { AccountBalances } from "../src/assets/controller.ts";
import { AssetsController } from "../src/assets/controller.ts";
import type { TronFeeQuote } from "../src/chains/tron.ts";
import { constantCall, tronFeeLimit } from "../src/chains/tron.ts";
import { HistoryController } from "../src/history/controller.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { PendingRequest } from "../src/requests/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { AccountRef, TrackedTransaction } from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import { idleNetworkDeps, requestsFor } from "./send-helpers.ts";

const RUN = process.env["ENGINE_E2E_TRON"] === "1";
const BASE = process.env["TRON_E2E_URL"] ?? "http://127.0.0.1:9090";
// TRE's own devnet id, not Nile: TRE lacks Nile's built-in USDT, so its balanceOf would fail
// refresh — the engine treats every tron:<caip> id the same once the host maps its rpc.
const NILE = "tron:2494104990";
const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
};

const trePair = async (): Promise<readonly [Uint8Array, Uint8Array]> => {
  const res = await fetch(`${BASE}/admin/accounts-json`);
  const body = (await res.json()) as { privateKeys: string[] };
  const [a, b] = body.privateKeys;
  if (a === undefined || b === undefined) {
    throw new Error("TRE exposes fewer than two funded accounts");
  }
  return [hexToBytes(a), hexToBytes(b)];
};

const addressOf = (priv: Uint8Array): string =>
  tronAddressFromPublicKey(secp256k1.getPublicKey(priv, false));

type Head = { readonly id: string; readonly number: number; readonly timestamp: number };
const head = async (): Promise<Head> => {
  const block = (await post("/wallet/getnowblock", {})) as {
    blockID: string;
    block_header: { raw_data: { number: number; timestamp: number } };
  };
  return {
    id: block.blockID,
    number: block.block_header.raw_data.number,
    timestamp: block.block_header.raw_data.timestamp,
  };
};

/** Build → sign with a TRE key → broadcast. Setup only — the wallet never signs node bytes. */
const setupTx = async (
  priv: Uint8Array,
  contract: TronContract,
  opts: { readonly feeLimit?: bigint } = {},
): Promise<string> => {
  const h = await head();
  const now = Date.now();
  const rawData = buildTronRawData(
    {
      refBlock: { number: h.number, id: h.id },
      timestamp: now,
      expiration: now + 60_000,
      ...(opts.feeLimit === undefined ? {} : { feeLimit: opts.feeLimit }),
    },
    contract,
  );
  const sig = signTronTransaction(rawData, priv);
  const res = await post("/wallet/broadcasthex", {
    transaction: bytesToHex(encodeTronTransaction(rawData, [sig])),
  });
  if (res["result"] !== true) {
    throw new Error(`setup broadcast refused: ${JSON.stringify(res)}`);
  }
  return String(res["txid"]);
};

const txInfo = async (txid: string, solid = false): Promise<Record<string, unknown>> =>
  post(solid ? "/walletsolidity/gettransactioninfobyid" : "/wallet/gettransactioninfobyid", {
    value: txid,
  });

const waitInfo = async (txid: string, deadline: number): Promise<Record<string, unknown>> => {
  const body = await txInfo(txid);
  if (body["receipt"] !== undefined || body["fee"] !== undefined || body["id"] !== undefined) {
    return body;
  }
  if (Date.now() > deadline) {
    throw new Error(`${txid} never landed`);
  }
  await sleep(1000);
  return waitInfo(txid, deadline);
};

const waitFinal = async (
  ctl: TransactionController,
  id: string,
  deadline: number,
): Promise<TrackedTransaction> => {
  const tx = ctl.getState().txs[id];
  if (tx !== undefined && tx.final === true) {
    return tx;
  }
  if (Date.now() > deadline) {
    throw new Error(`${id} never went final: ${JSON.stringify(tx)}`);
  }
  await sleep(1500);
  return waitFinal(ctl, id, deadline);
};

const rawOf = (tx: TrackedTransaction): string => {
  if (tx.raw === undefined) {
    throw new Error("signed bytes were not persisted before broadcast");
  }
  return tx.raw;
};

const hashOf = (tx: TrackedTransaction): string => {
  if (tx.hash === undefined) {
    throw new Error("the tracked transaction has no txid");
  }
  return tx.hash;
};

const expirationOf = (tx: TrackedTransaction): number => tx.tron?.expiration ?? 0;

const dappSig = (tx: TrackedTransaction): string => {
  const signature = tx.tron?.dappSignature;
  if (signature === undefined) {
    throw new Error("the observed entry carries no dappSignature");
  }
  return signature;
};

const receiptField = (info: Record<string, unknown>, field: string): unknown =>
  (info["receipt"] as Record<string, unknown> | undefined)?.[field];

/** `receipt.result` — absent on plain system contracts, which TRE treats as SUCCESS. */
const receiptResult = (info: Record<string, unknown>): unknown =>
  receiptField(info, "result") ?? "SUCCESS";

const netFeeOf = (info: Record<string, unknown>): bigint =>
  BigInt(String(receiptField(info, "net_fee") ?? 0));

const intentExpiration = (pending: PendingRequest): number => {
  const expiration = "tron" in pending.display ? pending.display.tron?.expiration : undefined;
  if (expiration === undefined) {
    throw new Error("the send intent carries no tron expiration");
  }
  return expiration;
};

const stateOf = (ctl: TransactionController, id: string): string | undefined =>
  ctl.getState().txs[id]?.state;

const tronFeeOf = (pending: PendingRequest): TronFeeQuote => {
  if (pending.tronFee === undefined) {
    throw new Error("the pending request carries no tronFee quote");
  }
  return pending.tronFee;
};

const energyUsed = (pending: PendingRequest): bigint =>
  BigInt(tronFeeOf(pending).energy?.used ?? 0);

const infoFee = (info: Record<string, unknown>): bigint => BigInt(String(info["fee"] ?? 0));

const energyTotal = (info: Record<string, unknown>): bigint => {
  const receipt = info["receipt"] as { energy_usage_total?: number } | undefined;
  return BigInt(receipt?.energy_usage_total ?? 0);
};

const frozenEnergy = (bal: AccountBalances): bigint => BigInt(bal.tron?.frozen.energy ?? "0");

const unfreezingCount = (bal: AccountBalances): number => bal.tron?.unfreezing.length ?? 0;

/** Raw_data = proto field 1 of the broadcast Transaction envelope (varint length prefix). */
const stripEnvelope = (hex: string): Uint8Array => {
  const bytes = hexToBytes(hex);
  if (bytes[0] !== 0x0a) {
    throw new Error("envelope's first field is not raw_data");
  }
  let shift = 0;
  let length = 0;
  let i = 1;
  for (;;) {
    const b = bytes[i] ?? 0;
    length += (b % 128) * 2 ** shift;
    i += 1;
    if (b < 128) {
      break;
    }
    shift += 7;
  }
  return bytes.subarray(i, i + length);
};

const forge = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/forge`;
  return existsSync(local) ? local : execFileSync("which", ["forge"]).toString().trim();
};

const pad32 = (n: bigint): string => n.toString(16).padStart(64, "0");

const compile = (contract: string): { bytecode: string; abi: string } => {
  const dir = mkdtempSync(join(tmpdir(), "tre-token-"));
  try {
    execFileSync(forge(), ["init", "--no-commit", "--quiet", dir]);
    execFileSync("cp", [join(import.meta.dirname, `fixtures/${contract}.sol`), join(dir, "src")]);
    execFileSync(forge(), ["build", "--root", dir, "--quiet"]);
    const out = join(dir, `out/${contract}.sol/${contract}.json`);
    const artifact = JSON.parse(readFileSync(out, "utf8")) as {
      bytecode: { object: string };
      abi: unknown;
    };
    return { bytecode: artifact.bytecode.object, abi: JSON.stringify(artifact.abi) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** `/wallet/deploycontract` — the node's own deploy path; the returned tx is signed with a TRE key. */
const deployContract = async (
  owner: string,
  priv: Uint8Array,
  contract: string,
  ctorArgs = "",
): Promise<string> => {
  const { bytecode, abi } = compile(contract);
  const unsigned = await post("/wallet/deploycontract", {
    owner_address: owner,
    abi,
    bytecode: `${bytecode}${ctorArgs}`,
    name: contract,
    consume_user_resource_percent: 100,
    origin_energy_limit: 1_000_000,
    fee_limit: 1_000_000_000,
    call_value: 0,
    visible: true,
  });
  const rawHex = unsigned["raw_data_hex"];
  if (typeof rawHex !== "string") {
    throw new TypeError(`deploycontract did not return raw_data_hex: ${JSON.stringify(unsigned)}`);
  }
  const rawData = hexToBytes(rawHex);
  const sig = signTronTransaction(rawData, priv);
  const res = await post("/wallet/broadcasthex", {
    transaction: bytesToHex(encodeTronTransaction(rawData, [sig])),
  });
  if (res["result"] !== true) {
    throw new Error(`deploy broadcast refused: ${JSON.stringify(res)}`);
  }
  const info = await waitInfo(String(res["txid"]), Date.now() + 120_000);
  const receipt = info["receipt"] as { result?: string } | undefined;
  if (receipt?.result !== "SUCCESS") {
    throw new Error(`deploy failed: ${JSON.stringify(info)}`);
  }
  const contractAddress = info["contract_address"];
  if (typeof contractAddress !== "string") {
    throw new TypeError(`no contract_address in deploy receipt: ${JSON.stringify(info)}`);
  }
  return isTronAddress(contractAddress) ? contractAddress : tronAddressFromHex(contractAddress);
};

const realTimer = (ms: number, fn: () => unknown): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => {
    clearTimeout(id);
  };
};

const waitUntil = async (check: () => boolean, deadline = Date.now() + 60_000): Promise<void> => {
  if (check()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error("waitUntil timed out");
  }
  await sleep(1000);
  return waitUntil(check, deadline);
};

const trc20Row =
  (spender: string) =>
  (r: ApprovalsView["rows"][number]): boolean =>
    r.kind === "trc20" && r.spender.toLowerCase() === spender.toLowerCase();

const mustFind = <T>(list: ReadonlyArray<T>, pred: (item: T) => boolean, name: string): T => {
  const found = list.find(pred);
  if (found === undefined) {
    throw new Error(`expected ${name} missing`);
  }
  return found;
};

const liveChainParameters = async (): Promise<Map<string, number>> => {
  const body = (await post("/wallet/getchainparameters", {})) as {
    chainParameter: Array<{ key: string; value?: number }>;
  };
  return new Map(body.chainParameter.map((p) => [p.key, p.value ?? 0]));
};

const param = (params: Map<string, number>, key: string): bigint => BigInt(params.get(key) ?? 0);

/** Fails `/wallet/broadcasthex`; everything else reaches the node. */
const blockedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/wallet/broadcasthex")) {
    throw new TypeError("broadcast blocked");
  }
  return fetch(input, init);
};

const tronOnly = (family: string): string[] => (family === "tron" ? [NILE] : []);

/** Node-side tronweb — builds dApp transactions against TRE exactly as sun.io's page would. */
const tw = new TronWeb({ fullHost: BASE });

const accountFor =
  (address: string) =>
  async (p: { template: string }): Promise<{ address: string }> =>
    p.template === "tron.bip44"
      ? Promise.resolve({ address })
      : Promise.reject(new Error("unexpected template"));

const entriesOf = (group: { entries?: ReadonlyArray<unknown> } | undefined): unknown[] =>
  group?.entries === undefined ? [] : [...group.entries];

const deriveAddress = async (wallet: Wallet, walletId: string): Promise<string> => {
  const derived = await chains(wallet).account({
    walletId,
    groupIndex: 0,
    template: "tron.bip44",
    network: NILE,
  });
  if (!("address" in derived)) {
    throw new Error("no tron.bip44 address for group 0");
  }
  return derived.address;
};

const waitFunded = async (
  assets: AssetsController,
  address: string,
  deadline: number,
): Promise<AccountBalances> => {
  const bal = await assets.refresh(address, NILE);
  if (BigInt(bal.native) > 0n) {
    return bal;
  }
  if (Date.now() > deadline) {
    throw new Error("funding never landed");
  }
  await sleep(1500);
  return waitFunded(assets, address, deadline);
};

/** A 1-sun setup transfer — each accepted transaction mints a fresh block on TRE. */
const tick = async (priv: Uint8Array, owner: string, to: string): Promise<string> =>
  setupTx(priv, { type: "TransferContract", owner, to, amount: 1n });

/** TRE's mempool checkTx runs at the current head; keep ticking until its parity is `want`. */
const waitHeadParity = async (
  want: 0 | 1,
  tickFn: () => Promise<string>,
  deadline: number,
): Promise<void> => {
  const h = await head();
  if (h.number % 2 === want) {
    return;
  }
  if (Date.now() > deadline) {
    throw new Error(`head never reached parity ${want}`);
  }
  await tickFn();
  await sleep(1000);
  return waitHeadParity(want, tickFn, deadline);
};

const waitDropped = async (
  ctl: TransactionController,
  id: string,
  tickFn: () => Promise<string>,
  deadline: number,
): Promise<void> => {
  const state = ctl.getState().txs[id];
  if (state?.state === "dropped") {
    return;
  }
  if (Date.now() > deadline) {
    throw new Error(`never dropped: ${JSON.stringify(state)}`);
  }
  await tickFn().catch(() => "");
  await sleep(1500);
  return waitDropped(ctl, id, tickFn, deadline);
};

describe.runIf(RUN)("tron e2e: TRE devnet", () => {
  let tre0: Uint8Array;
  let tre0Addr: string;
  let tre1Addr: string;
  let ticker: () => Promise<string>;
  let wallet: Wallet;
  let walletId: string;
  let account: AccountRef;
  let A: string;
  let C: string;
  let networks: NetworkController;
  let transactions: TransactionController;
  let requests: Awaited<ReturnType<typeof requestsFor>>;
  let assets: AssetsController;
  let activation: string;
  let energyFee: bigint;
  let maxFeeLimit: bigint;
  let memoFeeSun: bigint;
  let tokenAddress: string;

  /** `tron-sign` prepare+approve for a dApp-built `raw_data` — observed, never broadcast by us. */
  const dappTronSign = async (rawData: Uint8Array): Promise<TrackedTransaction> => {
    const pending = await requests.prepare({
      method: "tron-sign",
      origin: { kind: "browser", origin: "https://dapp.e2e.qntx" },
      account,
      network: NILE,
      request: { kind: "tron.transaction", network: NILE, account, rawData },
    });
    const result = await requests.approve(pending.id, "tron-sign", approval(pending, VERIFY));
    if (!("state" in result)) {
      throw new Error("a transaction tron-sign must return the tracked entry");
    }
    return result;
  };

  beforeAll(async () => {
    const [first, second] = await trePair();
    tre0 = first;
    tre0Addr = addressOf(first);
    tre1Addr = addressOf(second);
    ticker = async (): Promise<string> => tick(tre0, tre0Addr, tre1Addr);

    wallet = await createNodeWallet({
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
    ({ walletId } = info);
    account = { kind: "hd", walletId, groupIndex: 0, template: "tron.bip44" };
    A = await deriveAddress(wallet, walletId);

    networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: globalThis.fetch.bind(globalThis),
      rpc: { [NILE]: [BASE] },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: { warn: () => undefined },
    });
    transactions = new TransactionController({
      wallet,
      chains: chains(wallet),
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (n) => randomBytes(n),
      setTimer: realTimer,
      now: () => Date.now(),
      logger: { warn: () => undefined },
      pollMs: 500,
    });
    await transactions.init();
    requests = await requestsFor(transactions);
    assets = new AssetsController({
      ownBitcoinTxids: () => new Set(),
      networks,
      chains: { account: async () => Promise.reject(new Error("unmocked chains.account")) },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: () => () => {},
      logger: { warn: () => undefined },
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await assets.init();

    const params = await liveChainParameters();
    activation = String(param(params, "getCreateNewAccountFeeInSystemContract"));
    energyFee = param(params, "getEnergyFee");
    maxFeeLimit = param(params, "getMaxFeeLimit");
    memoFeeSun = param(params, "getMemoFee");
  }, 120_000);

  it(
    "funds the derived account and refresh shows TRX with the resources view",
    { timeout: 180_000 },
    async () => {
      await setupTx(tre0, {
        type: "TransferContract",
        owner: tre0Addr,
        to: A,
        amount: 2_000_000_000n, // 2000 TRX
      });
      const funded = await waitFunded(assets, A, Date.now() + 120_000);
      expect(funded.tron).toBeDefined();
      expect(funded.tron?.energy.limit).toBeDefined();
      expect(funded.tron?.bandwidth.free.limit).toBeDefined();
    },
  );

  it(
    "sends TRX to a fresh address — activation warning, signed bytes match the preview, final",
    { timeout: 300_000 },
    async () => {
      const B = addressOf(randomBytes(32));
      const pending = await requests.prepare({
        method: "send",
        account,
        network: NILE,
        to: B,
        amount: 5_000_000n,
        fee: "normal",
      });
      expect(tronFeeOf(pending).warnings).toContain("recipient-not-activated");
      expect(tronFeeOf(pending).activation).toBe(activation);
      const sent = await requests.approve(pending.id, "send", approval(pending, VERIFY));
      expect(sent.state).toBe("submitted");
      const finalTx = await waitFinal(transactions, sent.id, Date.now() + 240_000);
      expect(finalTx.state).toBe("confirmed");
      // The persisted broadcast bytes decode to exactly the intent the approval previewed.
      const rawData = stripEnvelope(rawOf(finalTx));
      const decoded = decodeTron({ kind: "tron.transaction", network: NILE, account, rawData }, A);
      expect(decoded).toStrictEqual(pending.display);
      const sentInfo = await txInfo(hashOf(sent));
      expect(infoFee(sentInfo)).toBe(BigInt(tronFeeOf(pending).expected));
      expect(infoFee(sentInfo)).toBeLessThanOrEqual(BigInt(tronFeeOf(pending).max));
    },
  );

  it(
    "deploys a TRC-20 and sends it with a live energy quote and fee limit",
    { timeout: 600_000 },
    async () => {
      const token = await deployContract(
        tre0Addr,
        tre0,
        "TestToken",
        pad32(1_000_000n * 10n ** 18n),
      );
      tokenAddress = token;
      await waitInfo(
        await setupTx(tre0, trc20TransferContract(tre0Addr, token, A, 500n * 10n ** 18n), {
          feeLimit: 500_000_000n,
        }),
        Date.now() + 120_000,
      );
      await assets.addToken(NILE, token);
      C = addressOf(randomBytes(32));
      await setupTx(tre0, {
        type: "TransferContract",
        owner: tre0Addr,
        to: C,
        amount: 300_000_000n,
      });
      const tokenSend = await requests.prepare({
        method: "send",
        account,
        network: NILE,
        to: C,
        amount: 100n * 10n ** 18n,
        token,
        fee: "normal",
      });
      expect(energyUsed(tokenSend)).toBeGreaterThan(0n);
      const sentToken = await requests.approve(tokenSend.id, "send", approval(tokenSend, VERIFY));
      const tokenFinal = await waitFinal(transactions, sentToken.id, Date.now() + 240_000);
      expect(tokenFinal.state).toBe("confirmed");
      const tokenRaw = decodeTronRawData(stripEnvelope(rawOf(tokenFinal)));
      const used = energyUsed(tokenSend);
      expect(tokenRaw.feeLimit).toBe(tronFeeLimit(Number(used), energyFee, maxFeeLimit));
      const tokenInfo = await txInfo(hashOf(sentToken));
      expect(energyTotal(tokenInfo) * 2n).toBeLessThanOrEqual(used * 3n);
      const refreshed = await assets.refresh(A, NILE);
      expect(refreshed.tokens.some((t) => t.address === token)).toBe(true);
    },
  );

  it(
    "approves through the pipeline, lists the trc20 row locally and revokes it",
    { timeout: 600_000 },
    async () => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- shared fixture presence guard
      if (tokenAddress === undefined) {
        throw new Error("the TRC-20 deploy test must run first");
      }
      const approvals = new ApprovalsController({
        networks,
        transactions,
        gateway: undefined,
        fetch: globalThis.fetch,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        setTimer: realTimer,
        now: () => Date.now(),
        logger: { warn: () => undefined },
        addressOf: async (ref, network) => transactions.addressOf(ref, network),
        known: () => [],
        tokenMetadata: async () => Promise.resolve({ symbol: "TST", decimals: 18 }),
        sessions: async () => Promise.resolve([]),
        prepare: async (input) => requests.prepare(input),
      });
      await approvals.init();

      const granted = await requests.prepare({
        method: "tron-approve",
        account,
        network: NILE,
        token: tokenAddress,
        spender: tre1Addr,
        amount: 123n,
      });
      const sent = await requests.approve(granted.id, "tron-approve", approval(granted, VERIFY));
      const final = await waitFinal(transactions, sent.id, Date.now() + 240_000);
      expect(final.state).toBe("confirmed");

      const key = await approvals.load(account, NILE);
      const view = (): ApprovalsView =>
        mustFind(Object.values(approvals.getState().views), (v) => v.key === key, "view");
      await waitUntil(() => view().status === "ready");
      /* TRE serves no `/v1` indexer: the row comes from the wallet's own tracked transaction. */
      expect(view().sources).toContainEqual(
        expect.objectContaining({ source: "gateway", status: "unavailable" }),
      );
      const trc20 = mustFind(view().rows, trc20Row(tre1Addr), "trc20 row");
      expect(trc20).toMatchObject({ kind: "trc20", amount: "123", unlimited: false });
      expect(trc20.sources).toContain("local");

      const revokePending = await approvals.revoke(key, trc20.id);
      expect(revokePending.display).toMatchObject({
        approvals: [{ kind: "allowance", amount: { amount: "0" } }],
      });
      const revoked = await requests.approve(
        revokePending.id,
        "tron-approve",
        approval(revokePending, VERIFY),
      );
      await waitFinal(transactions, revoked.id, Date.now() + 240_000);
      await waitUntil(() => !view().rows.some(trc20Row(tre1Addr)));
      const outcome = await constantCall(networks.tronApi(NILE), {
        owner: A,
        contract: tokenAddress,
        data: hexToBytes(
          `dd62ed3e${tronAddressToEvm(A).slice(2).padStart(64, "0")}${tronAddressToEvm(tre1Addr).slice(2).padStart(64, "0")}`,
        ),
      });
      // oxlint-disable-next-line vitest/no-conditional-in-test -- union narrowing on ok
      const outcomeResult = outcome.ok ? outcome.result : new Uint8Array([1]);
      expect(bytesToHex(outcomeResult).replace(/^0+/, "")).toBe("");
    },
  );

  it(
    "freezes and unfreezes TRX for energy — the resources view reflects both",
    { timeout: 600_000 },
    async () => {
      const freeze = await requests.prepare({
        method: "tron-stake",
        account,
        network: NILE,
        action: { kind: "freeze", amount: 10_000_000n, resource: "energy" },
      });
      const frozen = await requests.approve(freeze.id, "tron-stake", approval(freeze, VERIFY));
      await waitFinal(transactions, frozen.id, Date.now() + 240_000);
      const afterFreeze = await assets.refresh(A, NILE);
      expect(frozenEnergy(afterFreeze)).toBeGreaterThanOrEqual(10_000_000n);
      const unfreeze = await requests.prepare({
        method: "tron-stake",
        account,
        network: NILE,
        action: { kind: "unfreeze", amount: 5_000_000n, resource: "energy" },
      });
      const unfrozen = await requests.approve(
        unfreeze.id,
        "tron-stake",
        approval(unfreeze, VERIFY),
      );
      await waitFinal(transactions, unfrozen.id, Date.now() + 240_000);
      const afterUnfreeze = await assets.refresh(A, NILE);
      expect(unfreezingCount(afterUnfreeze)).toBeGreaterThan(0);
    },
  );

  it(
    "a real cost above the estimate fails on-chain with OUT_OF_ENERGY",
    { timeout: 600_000 },
    async () => {
      // ParityBomb.transfer costs one SSTORE loop on even blocks and LOOPS on odd ones. TRE's
      // mempool admission executes the call against the current head, so the estimate and the
      // admission check both see the cheap path at an even head — the transaction then lands
      // in the next (odd) block where the real cost blows past fee_limit: a failed receipt.
      // (A storage bump between prepare and approve would instead be refused at broadcasthex
      // — TRE never lets an out-of-energy transaction into a block.)
      const bomb = await deployContract(tre0Addr, tre0, "ParityBomb", pad32(10n ** 18n));
      await waitInfo(
        await setupTx(tre0, trc20TransferContract(tre0Addr, bomb, A, 10n ** 18n), {
          feeLimit: 500_000_000n,
        }),
        Date.now() + 120_000,
      );
      // Only our own transactions mint blocks, so an even head stays even until we broadcast.
      await waitHeadParity(0, ticker, Date.now() + 120_000);
      const doomed = await requests.prepare({
        method: "send",
        account,
        network: NILE,
        to: C,
        amount: 1n * 10n ** 18n,
        token: bomb,
        fee: "normal",
      });
      expect(energyUsed(doomed)).toBeGreaterThan(0n);
      const failed = await requests.approve(doomed.id, "send", approval(doomed, VERIFY));
      const failedFinal = await waitFinal(transactions, failed.id, Date.now() + 240_000);
      expect(failedFinal.state).toBe("failed");
      expect(failedFinal.error).toContain("OUT_OF_ENERGY");
      expect(failedFinal.error).toContain("burned");
    },
  );

  it(
    "a blocked broadcast stays submitted until the head passes expiration, then drops",
    { timeout: 400_000 },
    async () => {
      const blockedNetworks = new NetworkController({
        ...idleNetworkDeps,
        fetch: blockedFetch,
        rpc: { [NILE]: [BASE] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => undefined },
      });
      const blockedTxs = new TransactionController({
        wallet,
        chains: chains(wallet),
        networks: blockedNetworks,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        random: (n) => randomBytes(n),
        setTimer: realTimer,
        now: () => Date.now(),
        logger: { warn: () => undefined },
        pollMs: 500,
      });
      await blockedTxs.init();
      const blockedRequests = await requestsFor(blockedTxs);
      const blockedPending = await blockedRequests.prepare({
        method: "send",
        account,
        network: NILE,
        to: tre0Addr,
        amount: 1_000_000n,
        fee: "normal",
      });
      const blocked = await blockedRequests.approve(
        blockedPending.id,
        "send",
        approval(blockedPending, VERIFY),
      );
      expect(blocked.state).toBe("submitted");
      const expiration = expirationOf(blocked);
      expect(expiration).toBeGreaterThan(Date.now());
      await sleep(Math.max(0, expiration - Date.now() - 15_000));
      // Still in flight with the expiry close — nothing is dropped early.
      expect(stateOf(blockedTxs, blocked.id)).toBe("submitted");
      // The head only passes expiration while other transactions keep landing — tick it.
      await waitDropped(blockedTxs, blocked.id, ticker, Date.now() + 240_000);
    },
  );

  it(
    "history lists the local sends only — TRE serves no /v1 indexer",
    { timeout: 60_000 },
    async () => {
      const history = new HistoryController({
        networks: {
          enabled: tronOnly,
          tronApi: networks.tronApi.bind(networks),
          independentTronApi: networks.independentTronApi.bind(networks),
          esplora: () => ({ get: async () => Promise.reject(new Error("unmocked")) }),
          independentEsplora: () => ({ kind: "unavailable" }),
        },
        chains: { account: accountFor(A) },
        spark: {
          history: async () => Promise.resolve({ items: [], nextOffset: undefined }),
          store: { getState: () => ({ accounts: {} }), subscribe: () => () => {} },
        },
        sparkNetwork: "regtest",
        transactions: { store: transactions.store },
        addressBook: { store: { getState: () => ({ entries: {} }), subscribe: () => () => {} } },
        gateway: undefined,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        setTimer: () => () => {},
        logger: { warn: () => undefined },
        now: () => Date.now(),
      } as never);
      await history.init();
      await history.load({ walletId, groupIndex: 0 });
      const group = history.getState().groups[`${walletId}:0`];
      const tronEntries = entriesOf(group).filter(
        (e): e is { family: string; origin: string } => (e as { family: string }).family === "tron",
      );
      expect(tronEntries.length).toBeGreaterThanOrEqual(4);
      expect(tronEntries.every((e) => e.origin === "local")).toBe(true);
    },
  );

  it(
    "a dApp's tronweb-built TRX transfer signs, pairs and broadcasts — final",
    { timeout: 300_000 },
    async () => {
      const tx = await tw.transactionBuilder.sendTrx(tre1Addr, 1_000_000, A);
      const rawData = hexToBytes(tx.raw_data_hex);
      const signed = await dappTronSign(rawData);
      expect(signed.raw).toBeUndefined();
      const sent = await transactions.submitDappTron(NILE, rawData, hexToBytes(dappSig(signed)));
      expect(sent.id).toBe(signed.id);
      const finalTx = await waitFinal(transactions, sent.id, Date.now() + 240_000);
      expect(finalTx.state).toBe("confirmed");
      const info = await txInfo(hashOf(sent));
      expect(receiptResult(info)).toBe("SUCCESS");
    },
  );

  it(
    "a dApp's tronweb-built TRC-20 transfer signs, pairs and broadcasts — final",
    { timeout: 300_000 },
    async () => {
      const built = await tw.transactionBuilder.triggerSmartContract(
        tokenAddress,
        "transfer(address,uint256)",
        { feeLimit: 500_000_000 },
        [
          { type: "address", value: tre1Addr },
          { type: "uint256", value: "1000000" },
        ],
        A,
      );
      const tx = built.transaction;
      const rawData = hexToBytes(tx.raw_data_hex);
      const signed = await dappTronSign(rawData);
      const sent = await transactions.submitDappTron(NILE, rawData, hexToBytes(dappSig(signed)));
      const finalTx = await waitFinal(transactions, sent.id, Date.now() + 240_000);
      expect(finalTx.state).toBe("confirmed");
      const info = await txInfo(hashOf(sent));
      expect(receiptResult(info)).toBe("SUCCESS");
    },
  );

  it(
    "a dApp broadcasting the signed bytes itself finalizes — the wallet never broadcast",
    { timeout: 300_000 },
    async () => {
      const tx = await tw.transactionBuilder.sendTrx(tre1Addr, 1_000_000, A);
      const rawData = hexToBytes(tx.raw_data_hex);
      const signed = await dappTronSign(rawData);
      // The dApp — not the wallet — sends the signed transaction to the node.
      const res = await post("/wallet/broadcasttransaction", {
        ...tx,
        signature: [dappSig(signed)],
      });
      expect(res["result"]).toBe(true);
      const finalTx = await waitFinal(transactions, signed.id, Date.now() + 240_000);
      expect(finalTx.state).toBe("confirmed");
      // `pollTron` only ever sends `tx.raw`; the entry never gained signed bytes.
      expect(finalTx.raw).toBeUndefined();
    },
  );

  it(
    "a signed dApp transaction nobody broadcasts drops once the head passes its expiration",
    { timeout: 400_000 },
    async () => {
      const tx = await tw.transactionBuilder.sendTrx(tre1Addr, 1_000_000, A);
      const rawData = hexToBytes(tx.raw_data_hex);
      const signed = await dappTronSign(rawData);
      expect(signed.raw).toBeUndefined();
      const { expiration } = tx.raw_data;
      const deadline = Date.now() + Math.max(0, expiration - Date.now()) + 240_000;
      await waitDropped(transactions, signed.id, ticker, deadline);
      expect(transactions.getState().txs[signed.id]?.raw).toBeUndefined();
    },
  );

  it(
    "an engine send approved with under 20 s left rebuilds on the fresh head — final",
    { timeout: 300_000 },
    async () => {
      let clock = Date.now();
      const timedNetworks = new NetworkController({
        ...idleNetworkDeps,
        fetch: globalThis.fetch.bind(globalThis),
        rpc: { [NILE]: [BASE] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => undefined },
      });
      const timedTxs = new TransactionController({
        wallet,
        chains: chains(wallet),
        networks: timedNetworks,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        random: (n) => randomBytes(n),
        setTimer: realTimer,
        now: () => clock,
        logger: { warn: () => undefined },
        pollMs: 500,
      });
      await timedTxs.init();
      const timedRequests = await requestsFor(timedTxs);
      const pending = await timedRequests.prepare({
        method: "send",
        account,
        network: NILE,
        to: tre1Addr,
        amount: 1_000_000n,
        fee: "normal",
      });
      const originalExpiration = intentExpiration(pending);
      // Under the 20 s freshness bound the route rebuilds on a fresh solidified head.
      clock = originalExpiration - 19_000;
      const sent = await timedRequests.approve(pending.id, "send", approval(pending, VERIFY));
      const finalTx = await waitFinal(timedTxs, sent.id, Date.now() + 240_000);
      expect(finalTx.state).toBe("confirmed");
      const rebuilt = decodeTronRawData(stripEnvelope(rawOf(finalTx)));
      expect(Number(rebuilt.expiration)).toBe(originalExpiration + 41_000);
      expect(expirationOf(finalTx)).toBe(originalExpiration + 41_000);
    },
  );

  it(
    "a memo send lands — raw_data.data equals the memo and the receipt carries the memo fee",
    { timeout: 300_000 },
    async () => {
      const pending = await requests.prepare({
        method: "send",
        account,
        network: NILE,
        to: tre1Addr,
        amount: 1_000_000n,
        fee: "normal",
        memo: "qntx e2e",
      });
      expect(tronFeeOf(pending).memo).toBe(memoFeeSun.toString(10));
      const sent = await requests.approve(pending.id, "send", approval(pending, VERIFY));
      const finalTx = await waitFinal(transactions, sent.id, Date.now() + 240_000);
      expect(finalTx.state).toBe("confirmed");
      const rebuilt = decodeTronRawData(stripEnvelope(rawOf(finalTx)));
      expect(new TextDecoder().decode(rebuilt.memo)).toBe("qntx e2e");
      const info = await txInfo(hashOf(sent));
      const netFee = netFeeOf(info);
      // TransferContract burns no energy: fee − net_fee is exactly the flat memo fee.
      expect(infoFee(info) - netFee).toBe(memoFeeSun);
    },
  );
});
