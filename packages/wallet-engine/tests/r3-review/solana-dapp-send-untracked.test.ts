/**
 * PoC for r3-review: engine.ts `solanaSign` (send=true branch) calls
 * `adapter.broadcast(rpc, wire)` directly — the signed wire is never persisted, the broadcast
 * outcome is never classified (unknown vs refused) and no transaction is tracked, and the
 * signature the RPC reports is forwarded to the dApp unchecked.
 * Bug: an HTTP 502 after the node received the bytes surfaces to the dApp as a plain failure
 * while nothing in the wallet tracks the possibly-landed transaction; and a "successful"
 * answer forwards whatever signature the RPC claims, which need not be the wallet's own
 * signature inside the broadcast wire.
 * Correct behaviour: persist the wire, classify the outcome like transactions/solana.ts does
 * (unknown stays tracked), and verify the reported signature against the wire.
 * These tests ASSERT THE CURRENT (BUGGY) BEHAVIOUR.
 */
import { randomBytes } from "node:crypto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createKeyPairFromBytes,
  createTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import type { SolanaWalletAccount } from "../../src/connect/solana.ts";
import { createWalletEngine } from "../../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../../src/store/memory.ts";
import { approval } from "../approval.ts";

const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const PW = { kind: "password" as const, password: PASSWORD };
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SITE = "https://app.example.com";
const RPC_SIG = base58.encode(new Uint8Array(64).fill(0x5a));
const sentWires: Uint8Array[] = [];
/** When true, sendTransaction records the wire and then answers HTTP 502 — the answer is lost. */
let send502 = false;

const rpcReply = (method: string, params: unknown[]): unknown => {
  if (method === "getGenesisHash") {
    return GENESIS;
  }
  if (method === "sendTransaction") {
    sentWires.push(Uint8Array.from(Buffer.from(String(params[0]), "base64")));
    return RPC_SIG;
  }
  throw new Error(`no rpc answer for ${method}`);
};

async function rig() {
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
  const backing = new Map<string, Map<string, Uint8Array>>();
  const engine = createWalletEngine({
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://solana.invalid" || init?.method !== "POST") {
        return Promise.reject(new Error("offline"));
      }
      const call = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      if (call.method === "sendTransaction") {
        // The node got the bytes…
        sentWires.push(Uint8Array.from(Buffer.from(String(call.params[0]), "base64")));
        if (send502) {
          // …but the answer never made it back.
          return Promise.resolve(new Response("Bad Gateway", { status: 502 }));
        }
      }
      let result: unknown;
      try {
        result =
          call.method === "sendTransaction"
            ? RPC_SIG
            : rpcReply(call.method, call.params);
      } catch (error) {
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32_601, message: (error as Error).message },
          }),
        );
      }
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: call.id, result }));
    },
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: () => undefined },
    showCallsStatus: () => undefined,
    openStore: async () => Promise.resolve(createMemoryEngineStore({ collections: backing })),
    rpc: { [SOL_NET]: ["https://solana.invalid"] },
  });
  const info = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: { kind: "password", password: PASSWORD },
  });
  await until(() => engine.accounts.getState().selected !== null);
  return { wallet, engine, walletId: info.walletId };
}

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

type Rig = Awaited<ReturnType<typeof rig>>;

async function connect(r: Rig): Promise<SolanaWalletAccount> {
  const pending = r.engine.solanaWallet.handle(SITE, { method: "standard:connect" });
  await until(() => r.engine.connections.pending().length > 0);
  const [entry] = r.engine.connections.pending();
  await r.engine.connections.approveConnection(entry?.id ?? "", {
    accounts: [],
    network: SOL_NET,
  });
  const { accounts } = (await pending) as { accounts: SolanaWalletAccount[] };
  const [account] = accounts;
  if (account === undefined) {
    throw new Error("connect returned no solana account");
  }
  return account;
}

type Settled = { value: unknown } | { error: unknown };

const call = async (
  r: Rig,
  method: string,
  params: unknown,
): Promise<{ settled: Promise<Settled>; approve: () => Promise<unknown> }> => {
  const settled = r.engine.solanaWallet.handle(SITE, { method, params }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const open = () =>
    Object.values(r.engine.requests.getState().requests).filter(
      (entry) => entry.stage === "awaiting-approval",
    );
  await until(() => open().length > 0);
  const [request] = open();
  if (request === undefined) {
    throw new Error("no pending request");
  }
  return {
    settled,
    approve: async () =>
      r.engine.requests.approve(request.id, "solana-sign", approval(request, PW)),
  };
};

const value = (outcome: Settled): unknown => {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
};

const COSIGNER_SEED = new Uint8Array(32).fill(9);
type TestKeyPair = Awaited<ReturnType<typeof createKeyPairFromBytes>>;

const keyPair = async (seed: Uint8Array): Promise<TestKeyPair> =>
  createKeyPairFromBytes(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));
const COSIGNER = base58.encode(ed25519.getPublicKey(COSIGNER_SEED));
const DEST = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

const transfer = (from: string, lamports: bigint): Instruction => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: address(DEST), role: AccountRole.WRITABLE },
    ],
    data,
  };
};

const wire = async (options: {
  feePayer: string;
  ixs: ReadonlyArray<Instruction>;
  version?: "legacy" | 0;
  presign?: TestKeyPair[];
}): Promise<Uint8Array> => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1000n },
    setTransactionMessageFeePayer(
      address(options.feePayer),
      createTransactionMessage({ version: options.version ?? "legacy" }),
    ),
  );
  for (const ix of options.ixs) {
    message = appendTransactionMessageInstruction(ix, message as never);
  }
  const compiled = compileTransaction(message as never);
  const tx =
    options.presign === undefined
      ? compiled
      : await partiallySignTransaction(options.presign, compiled);
  return new Uint8Array(getTransactionEncoder().encode(tx));
};

const slotSignature = (wireBytes: Uint8Array, signer: string): Uint8Array | undefined =>
  getTransactionDecoder().decode(wireBytes).signatures[address(signer)] ?? undefined;

const verifySlot = (wireBytes: Uint8Array, signer: string): boolean => {
  const decoded = getTransactionDecoder().decode(wireBytes);
  const signature = decoded.signatures[address(signer)];
  return (
    signature !== null &&
    signature !== undefined &&
    verifySolanaSignature(new Uint8Array(decoded.messageBytes), signature, signer)
  );
};

const signAndSendInput = async (account: SolanaWalletAccount): Promise<Uint8Array> =>
  wire({
    feePayer: account.address,
    ixs: [transfer(COSIGNER, 1000n)],
    version: 0,
    presign: [await keyPair(COSIGNER_SEED)],
  });

describe("PoC: solana dApp sign-and-send is untracked and unverified", () => {
  it("PoC: a 502 after the node received the signed wire fails the dApp call and tracks nothing", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      sentWires.length = 0;
      send502 = true;
      const input = await signAndSendInput(account);
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [input],
        chains: ["solana:mainnet"],
      });
      const approveError = await approve().then(
        () => undefined,
        (error: unknown) => error,
      );
      const outcome = await settled;
      console.log("approve() error:", approveError);
      console.log("dApp outcome:", outcome);
      // The dApp sees a plain failure even though the node got the fully signed transaction.
      expect("error" in outcome).toBe(true);
      expect(sentWires).toHaveLength(1);
      const [sent] = sentWires;
      expect(sent).toBeDefined();
      expect(verifySlot(sent ?? new Uint8Array(), account.address)).toBe(true);
      // Nothing was persisted and nothing is tracked: the possibly-landed tx is invisible.
      expect(Object.values(r.engine.transactions.getState().txs)).toHaveLength(0);
      const request = Object.values(r.engine.requests.getState().requests).find(
        (entry) => entry.method === "solana-sign",
      );
      expect(request?.stage).toBe("failed");
    } finally {
      send502 = false;
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  }, 60_000);

  it("PoC: the dApp gets the signature the RPC reports, not the wallet's signature in the wire", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      sentWires.length = 0;
      const input = await signAndSendInput(account);
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [input],
        chains: ["solana:mainnet"],
      });
      await approve();
      const out = value(await settled) as { signatures: Uint8Array[] };
      // The RPC-reported signature is forwarded verbatim…
      expect(out.signatures).toStrictEqual([base58.decode(RPC_SIG)]);
      const [sent] = sentWires;
      const actual = sent === undefined ? undefined : slotSignature(sent, account.address);
      expect(actual).toBeDefined();
      // …and it is NOT the signature the wallet put in the broadcast wire.
      expect(out.signatures[0]).not.toStrictEqual(actual);
      console.log(
        "rpc-reported sig:",
        base58.encode(out.signatures[0] ?? new Uint8Array()),
        "| wire sig:",
        actual === undefined ? "none" : base58.encode(actual),
      );
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  }, 60_000);
});
