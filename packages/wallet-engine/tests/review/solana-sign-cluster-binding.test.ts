// oxlint-disable vitest/no-conditional-in-test -- union narrowing and mocked fetches are inherent
// A dApp's `solana-sign` request signs the message bytes without ever checking that the lifetime
// they carry — a recent blockhash or a durable-nonce value — belongs to the selected cluster:
// the devnet endpoint is never asked whether the hash exists, so a signature a devnet session
// produces is equally valid on mainnet, where the same key controls the real funds.

import { randomBytes } from "node:crypto";

import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
} from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { decodeSolanaTransaction, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { createWalletEngine } from "../../src/engine.ts";
import type { PendingRequest, SolanaSignResult } from "../../src/index.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../../src/store/memory.ts";
import type { EngineStore } from "../../src/store/port.ts";
import { approval } from "../approval.ts";

const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const PW = { kind: "password" as const, password: PASSWORD };
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GATEWAY = "https://gateway.test";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_RPC = "https://devnet.invalid";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RECIPIENT = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
/* A blockhash standing in for one minted on mainnet: devnet does not know it, and would say so —
   if the wallet ever asked. */
const FOREIGN_BLOCKHASH = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const NONCE_ACCOUNT = "7porTR32j7zt69GG4AwoPQx3f3FL2RLpSDKGtPXWTeaQ";
const NONCE_AUTHORITY = "7tj9biW3KRJ7EEWmVUGigHiouCTXhV2dzcyvwma7Cyu7";
const NONCE_VALUE = "7xeSk1y3uibLNKmGvmbdyAVa9MfjNYiTZ2eb19chxKDp";

const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

const transferInstruction = (signer: string, to: string) => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, 1_000_000_000n, true);
  return {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: address(signer), role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data,
  };
};

const wire = (message: Uint8Array, signers: number): Uint8Array =>
  new Uint8Array([signers, ...new Uint8Array(64 * signers), ...message]);

/** Legacy message: 1 SOL signer → recipient, lifetime bound to a hash devnet has never seen. */
const blockhashTx = (signer: string): Uint8Array => {
  const message = new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(
        appendTransactionMessageInstruction(
          transferInstruction(signer, RECIPIENT),
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: address(FOREIGN_BLOCKHASH),
              lastValidBlockHeight: 1000n,
            } as never,
            setTransactionMessageFeePayer(
              address(signer),
              createTransactionMessage({ version: "legacy" }),
            ),
          ),
        ),
      ),
    ),
  );
  return wire(message, 1);
};

/**
 * Legacy message whose lifetime is a durable nonce: the first instruction advances the nonce
 * account and the nonce authority — not the wallet — is a second required signer. The wallet's slot
 * is still the only one it can fill.
 */
const nonceTx = (signer: string): Uint8Array => {
  const message = new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(
        appendTransactionMessageInstruction(
          transferInstruction(signer, RECIPIENT),
          setTransactionMessageLifetimeUsingDurableNonce(
            {
              nonce: NONCE_VALUE,
              nonceAccountAddress: address(NONCE_ACCOUNT),
              nonceAuthorityAddress: address(NONCE_AUTHORITY),
            } as never,
            setTransactionMessageFeePayer(
              address(signer),
              createTransactionMessage({ version: "legacy" }),
            ),
          ),
        ),
      ),
    ),
  );
  return wire(message, 2);
};

const fetchImpl = (methods: string[]): typeof globalThis.fetch => {
  return async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/risk/lists/phishing`) {
      return Response.json({ kind: "snapshot", version: 1, deny: [], allow: [] });
    }
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: [] });
    }
    const base = url.endsWith("/") ? url.slice(0, -1) : url;
    if (base === DEVNET_RPC) {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      methods.push(body.method);
      const table: Record<string, unknown> = {
        /* The honest devnet answers: the genesis is devnet's, the foreign blockhash is not a
           devnet hash, and the tip has moved on. Nothing asks. */
        getGenesisHash: DEVNET_GENESIS,
        isBlockhashValid: { context: { slot: 1 }, value: false },
        getLatestBlockhash: {
          context: { slot: 1 },
          value: {
            blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
            lastValidBlockHeight: 5000,
          },
        },
      };
      if (body.method in table) {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: table[body.method] });
      }
      /* Simulation reads (getMultipleAccounts, simulateTransaction) fail: an unavailable
         simulation only adds a check the approval acknowledges. */
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32_601, message: `method not found: ${body.method}` },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
};

async function until(read: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error("until() timed out");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function rig(methods: string[]) {
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
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const durableStore = (): EngineStore => {
    const store = createMemoryEngineStore(backing);
    return { collection: (name) => store.collection(name), close: async () => Promise.resolve() };
  };
  const engine = createWalletEngine({
    setTimer,
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: fetchImpl(methods),
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: () => undefined },
    showCallsStatus: () => undefined,
    openStore: async () => Promise.resolve(durableStore()),
    rpc: { [DEVNET]: [DEVNET_RPC] },
    gateway: { url: GATEWAY },
  });
  const info = await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC, factor: PW });
  await until(() => engine.accounts.getState().selected !== null);
  const account = await chains(wallet).account({
    walletId: info.walletId,
    groupIndex: 0,
    template: "solana.bip44-change",
    network: DEVNET,
  });
  if (!("address" in account)) {
    throw new Error("no solana address on the wallet group");
  }
  return { engine, walletId: info.walletId, address: account.address };
}

const signRequest = async (
  engine: Awaited<ReturnType<typeof rig>>["engine"],
  walletId: string,
  signer: string,
  transactions: ReadonlyArray<Uint8Array>,
): Promise<{ result: SolanaSignResult; request: PendingRequest }> => {
  const pending = await engine.requests.prepare({
    method: "solana-sign",
    origin: { kind: "browser", origin: "https://dapp.example" },
    account: { walletId, groupIndex: 0, address: signer },
    network: DEVNET,
    request: { kind: "transactions", transactions, send: false },
  });
  const result = await engine.requests.approve(pending.id, "solana-sign", approval(pending, PW));
  return { result, request: pending };
};

describe("solana-sign cluster binding", { timeout: 120_000 }, () => {
  it("signs a blockhash devnet does not know without ever asking about it", async () => {
    const methods: string[] = [];
    const { engine, walletId, address: signer } = await rig(methods);
    const tx = blockhashTx(signer);
    const { result, request } = await signRequest(engine, walletId, signer, [tx]);
    if (result.kind !== "solana.transactions" || result.send) {
      throw new Error(`unexpected result ${JSON.stringify(result)}`);
    }
    expect(result.signedTransactions).toHaveLength(1);
    const signed = result.signedTransactions?.[0];
    if (signed === undefined) {
      throw new Error("no signed transaction");
    }
    /* The wallet's signature over the message verifies — it would land on the cluster that
       minted the blockhash, which is not the cluster this session is connected to. */
    const { message } = decodeWire(signed, signer);
    const signature = signed.slice(1, 65);
    expect(verifySolanaSignature(message, signature, signer)).toBe(true);
    /* The binding proof — getGenesisHash, isBlockhashValid, getLatestBlockhash — never ran. The
       only methods the endpoint saw are the simulation reads, and signing did not wait on them
       answering truthfully: they all failed. */
    expect(methods).not.toContain("getGenesisHash");
    expect(methods).not.toContain("isBlockhashValid");
    expect(methods).not.toContain("getLatestBlockhash");
    expect(request.checks).toContain("simulation-unavailable");
  });

  it("signs a durable-nonce message whose nonce the devnet cluster never vouched for", async () => {
    const methods: string[] = [];
    const { engine, walletId, address: signer } = await rig(methods);
    const tx = nonceTx(signer);
    const { result } = await signRequest(engine, walletId, signer, [tx]);
    if (result.kind !== "solana.transactions" || result.send) {
      throw new Error(`unexpected result ${JSON.stringify(result)}`);
    }
    const signed = result.signedTransactions?.[0];
    if (signed === undefined) {
      throw new Error("no signed transaction");
    }
    const { message } = decodeWire(signed, signer);
    /* Two required signers — fee payer and the nonce authority; the wallet signs its own slot
       and leaves the authority's empty. */
    const signature = signed.slice(1, 65);
    expect(verifySolanaSignature(message, signature, signer)).toBe(true);
    expect(methods).not.toContain("getGenesisHash");
    expect(methods).not.toContain("isBlockhashValid");
    expect(methods).not.toContain("getLatestBlockhash");
  });
});

/** The message bytes and required-signer check the pipeline itself applies. */
const decodeWire = (wireBytes: Uint8Array, signer: string) => {
  return decodeSolanaTransaction(wireBytes, signer);
};
