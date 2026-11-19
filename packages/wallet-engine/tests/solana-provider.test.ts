import { randomBytes } from "node:crypto";

/**
 * The Solana Wallet Standard handler over a REAL Node kernel: connect approval, serialized
 * transactions signed in the wallet's own slot (cosigners preserved byte for byte, any required
 * signer position), batched inputs in order, and a sign-and-send that broadcasts the complete wire
 * transaction over a fake JSON-RPC endpoint.
 */
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
  getAddressEncoder,
  getSignatureFromTransaction,
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

import type { SolanaWalletAccount } from "../src/connect/solana.ts";
import { createWalletEngine } from "../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import type { SetTimer } from "../src/timer.ts";
import { approval } from "./approval.ts";
import { manualTimers } from "./support/timers.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
/** TransactionController's default status-poll interval. */
const TX_POLL_MS = 4000;
const PASSWORD = "correct horse battery staple";
const PW = { kind: "password" as const, password: PASSWORD };
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SITE = "https://app.example.com";
const RPC_SIG = base58.encode(new Uint8Array(64).fill(0x5a));
const sentWires: Uint8Array[] = [];
/** Transaction rows observed inside the node at each sendTransaction call. */
const persistedAtSend: Array<Array<Record<string, unknown>>> = [];
/** Signature → the status entry getSignatureStatuses reports; absent means unknown. */
const statuses = new Map<string, unknown>();
/** The height getBlockHeight reports. */
let height = 500;
/** What getBlockHeight answers at processed commitment; undefined answers `height`. */
let processedHeight: unknown;
/** The node's sendTransaction answers HTTP 502 — it got the bytes, the answer is lost. */
let send502 = false;
/** Index into sentWires the node refuses with a simulation error; undefined refuses none. */
let refuseAt: number | undefined;

const resetMock = (): void => {
  sentWires.length = 0;
  persistedAtSend.length = 0;
  statuses.clear();
  height = 500;
  processedHeight = undefined;
  send502 = false;
  refuseAt = undefined;
};

const rpcReply = (method: string, params: unknown[]): unknown => {
  if (method === "getGenesisHash") {
    return GENESIS;
  }
  if (method === "getBlockHeight") {
    const config = params[0];
    const processed =
      typeof config === "object" && config !== null && "commitment" in config
        ? config.commitment === "processed"
        : false;
    return processed && processedHeight !== undefined ? processedHeight : height;
  }
  if (method === "getEpochInfo") {
    return { absoluteSlot: 700, blockHeight: height };
  }
  if (method === "getSignatureStatuses") {
    const sigs = Array.isArray(params[0]) ? params[0] : [];
    return {
      context: { slot: 1 },
      value: sigs.map((s) => statuses.get(String(s)) ?? null),
    };
  }
  if (method === "sendTransaction") {
    if (refuseAt === sentWires.length - 1) {
      throw new Error(
        "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
      );
    }
    return RPC_SIG;
  }
  throw new Error(`no rpc answer for ${method}`);
};

async function rig(setTimer?: SetTimer) {
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
    ...(setTimer === undefined ? {} : { setTimer }),
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
        persistedAtSend.push(
          [...(backing.get("transactions")?.values() ?? [])].map(
            (raw) => JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>,
          ),
        );
        if (send502) {
          // …but the answer never made it back.
          return Promise.resolve(new Response("Bad Gateway", { status: 502 }));
        }
      }
      let result: unknown;
      try {
        result = rpcReply(call.method, call.params);
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
const SPONSOR_SEED = new Uint8Array(32).fill(11);
type TestKeyPair = Awaited<ReturnType<typeof createKeyPairFromBytes>>;

const keyPair = async (seed: Uint8Array): Promise<TestKeyPair> =>
  createKeyPairFromBytes(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));
const COSIGNER = base58.encode(ed25519.getPublicKey(COSIGNER_SEED));
const SPONSOR = base58.encode(ed25519.getPublicKey(SPONSOR_SEED));
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

const signedMessage = (wireBytes: Uint8Array): Uint8Array =>
  new Uint8Array(getTransactionDecoder().decode(wireBytes).messageBytes);

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

const broadcastWire = (): Uint8Array => {
  const [sent] = sentWires;
  if (sent === undefined) {
    throw new Error("no sendTransaction call captured");
  }
  return sent;
};

const signedAt = (outcome: Settled, index: number): Uint8Array => {
  const out = value(outcome) as { signedTransactions: Uint8Array[] };
  const signed = out.signedTransactions[index];
  if (signed === undefined) {
    throw new Error(`no signed transaction ${index} in the result`);
  }
  return signed;
};

/** A cosigned sign-and-send input: the wallet is fee payer, COSIGNER already signed. */
const signAndSendInput = async (account: SolanaWalletAccount): Promise<Uint8Array> =>
  wire({
    feePayer: account.address,
    ixs: [transfer(COSIGNER, 1000n)],
    version: 0,
    presign: [await keyPair(COSIGNER_SEED)],
  });

/** The stage of the test's one solana-sign request. */
const requestStage = (r: Rig): string | undefined =>
  Object.values(r.engine.requests.getState().requests).find(
    (entry) => entry.method === "solana-sign",
  )?.stage;

describe("solana provider over a real kernel", () => {
  it("connects with the group's address and its 32-byte public key", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      expect(account.publicKey).toStrictEqual(
        new Uint8Array(getAddressEncoder().encode(address(account.address))),
      );
      expect(account.chains).toStrictEqual(["solana:mainnet"]);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("signs legacy and v0 transactions in the wallet's slot, leaving the message untouched", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      for (const version of ["legacy", 0] as const) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one request at a time per origin
        const input = await wire({
          feePayer: account.address,
          ixs: [transfer(account.address, 1000n)],
          version,
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- one request at a time per origin
        const { settled, approve } = await call(r, "solana:signTransaction", {
          transactions: [input],
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- see above
        await approve();
        // oxlint-disable-next-line eslint/no-await-in-loop -- see above
        const signed = signedAt(await settled, 0);
        expect(signedMessage(signed)).toStrictEqual(signedMessage(input));
        expect(verifySlot(signed, account.address)).toBe(true);
      }
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("preserves a cosigner's signature byte-exact and fills the wallet's slot", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      const input = await wire({
        feePayer: account.address,
        ixs: [transfer(COSIGNER, 1000n)],
        version: 0,
        presign: [await keyPair(COSIGNER_SEED)],
      });
      const { settled, approve } = await call(r, "solana:signTransaction", {
        transactions: [input],
      });
      await approve();
      const signed = signedAt(await settled, 0);
      expect(slotSignature(signed, COSIGNER)).toStrictEqual(slotSignature(input, COSIGNER));
      expect(verifySlot(signed, account.address)).toBe(true);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("signs two transactions in one call, in input order", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      const a = await wire({ feePayer: account.address, ixs: [transfer(account.address, 1n)] });
      const b = await wire({
        feePayer: account.address,
        ixs: [transfer(account.address, 2n)],
        version: 0,
      });
      const { settled, approve } = await call(r, "solana:signTransaction", {
        transactions: [a, b],
      });
      await approve();
      const outcome = await settled;
      expect(
        (value(outcome) as { signedTransactions: Uint8Array[] }).signedTransactions,
      ).toHaveLength(2);
      for (const [i, input] of [a, b].entries()) {
        const signed = signedAt(outcome, i);
        expect(signedMessage(signed)).toStrictEqual(signedMessage(input));
        expect(verifySlot(signed, account.address)).toBe(true);
      }
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("signAndSend broadcasts the fully signed transaction and returns the wallet's own signature", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      resetMock();
      const input = await wire({
        feePayer: account.address,
        ixs: [transfer(COSIGNER, 1000n)],
        version: 0,
        presign: [await keyPair(COSIGNER_SEED)],
      });
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [input],
        chains: ["solana:mainnet"],
      });
      await approve();
      const out = value(await settled) as { signatures: Uint8Array[] };
      const sent = broadcastWire();
      for (const signer of [account.address, COSIGNER]) {
        expect(verifySlot(sent, signer)).toBe(true);
      }
      // The dApp gets the wallet's own signature out of the broadcast wire — the endpoint
      // reported RPC_SIG instead, which makes the outcome unknown but changes nothing else.
      const local: string = getSignatureFromTransaction(getTransactionDecoder().decode(sent));
      expect(local).not.toBe(RPC_SIG);
      expect(out.signatures).toStrictEqual([base58.decode(local)]);
      const [tx] = Object.values(r.engine.transactions.getState().txs);
      expect(tx?.state).toBe("submitted");
      expect(tx?.hash).toBe(local);
      expect(tx?.raw).toBe(Buffer.from(sent).toString("base64"));
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("a 502 after the node received the wire still resolves with the wallet's signature", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      resetMock();
      send502 = true;
      const input = await signAndSendInput(account);
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [input],
        chains: ["solana:mainnet"],
      });
      await approve();
      const out = value(await settled) as { signatures: Uint8Array[] };
      expect(sentWires).toHaveLength(1);
      const sent = broadcastWire();
      expect(verifySlot(sent, account.address)).toBe(true);
      const local: string = getSignatureFromTransaction(getTransactionDecoder().decode(sent));
      expect(out.signatures).toStrictEqual([base58.decode(local)]);
      // The wire and its id were persisted before the sendTransaction call reached the node.
      const persisted = persistedAtSend[0]?.filter((row) => row["hash"] === local) ?? [];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.["state"]).toBe("signed");
      expect(persisted[0]?.["raw"]).toBe(Buffer.from(sent).toString("base64"));
      // The lost answer keeps the transaction submitted and tracked, and the request ends
      // submitted — the dApp is never told the send failed.
      const [tx] = Object.values(r.engine.transactions.getState().txs);
      expect(tx?.state).toBe("submitted");
      expect(tx?.hash).toBe(local);
      expect(requestStage(r)).toBe("submitted");
    } finally {
      resetMock();
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("bounds a dApp transaction's expiry by the processed height, never the lagging confirmed one", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      resetMock();
      processedHeight = height + 40;
      const input = await signAndSendInput(account);
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [input],
        chains: ["solana:mainnet"],
      });
      await approve();
      value(await settled);
      const [tx] = Object.values(r.engine.transactions.getState().txs);
      expect(tx?.lastValidBlockHeight).toBe(height + 40 + 150);
    } finally {
      resetMock();
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("a malformed height answer fails the send before anything goes out", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      resetMock();
      processedHeight = "not-a-height";
      const input = await signAndSendInput(account);
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [input],
        chains: ["solana:mainnet"],
      });
      await expect(approve()).rejects.toThrow("getBlockHeight returned a malformed height");
      expect(await settled).toHaveProperty("error");
      expect(sentWires).toHaveLength(0);
      expect(r.engine.transactions.getState().txs).toStrictEqual({});
    } finally {
      resetMock();
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("a refused send fails the request and the transaction, nothing is tracked", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      resetMock();
      refuseAt = 0;
      const input = await signAndSendInput(account);
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [input],
        chains: ["solana:mainnet"],
      });
      await approve().then(
        () => undefined,
        () => undefined,
      );
      const outcome = await settled;
      expect("error" in outcome).toBe(true);
      const [tx] = Object.values(r.engine.transactions.getState().txs);
      expect(tx?.state).toBe("failed");
      expect(tx?.hash).toBeUndefined();
      expect(tx?.raw).toBeUndefined();
      expect(requestStage(r)).toBe("failed");
    } finally {
      resetMock();
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("a refused second transaction rejects the page but the first stays submitted and tracked", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      resetMock();
      refuseAt = 1;
      const first = await signAndSendInput(account);
      const second = await signAndSendInput(account);
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [first, second],
        chains: ["solana:mainnet", "solana:mainnet"],
      });
      await approve().then(
        () => undefined,
        () => undefined,
      );
      const outcome = await settled;
      // The page is told which input the network refused and which signature already went out.
      const sent = sentWires.map((w) =>
        getSignatureFromTransaction(getTransactionDecoder().decode(w)),
      );
      expect(sent).toHaveLength(2);
      const [sig0] = sent;
      expect("error" in outcome).toBe(true);
      const message = "error" in outcome ? String((outcome.error as Error).message) : "";
      expect(message).toContain("refused transaction 1");
      expect(message).toContain(sig0 ?? "");
      // The refused wire was sent exactly once and is failed; the first is submitted/tracked.
      const txs = Object.values(r.engine.transactions.getState().txs);
      const submitted = txs.filter((tx) => tx.state === "submitted");
      const failed = txs.filter((tx) => tx.state === "failed");
      expect(submitted.map((tx) => tx.hash)).toStrictEqual([sig0]);
      expect(failed).toHaveLength(1);
      expect(requestStage(r)).toBe("submitted");
    } finally {
      resetMock();
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("a tracked dApp send settles confirmed when a later poll sees the signature", async () => {
    const timers = manualTimers();
    const r = await rig(timers.setTimer);
    try {
      const account = await connect(r);
      resetMock();
      const input = await signAndSendInput(account);
      const { settled, approve } = await call(r, "solana:signAndSendTransaction", {
        transactions: [input],
        chains: ["solana:mainnet"],
      });
      await approve();
      const out = value(await settled) as { signatures: Uint8Array[] };
      const sent = broadcastWire();
      const local: string = getSignatureFromTransaction(getTransactionDecoder().decode(sent));
      expect(out.signatures).toStrictEqual([base58.decode(local)]);
      statuses.set(local, { confirmationStatus: "confirmed", err: null, slot: 600 });
      await timers.fire(TX_POLL_MS);
      const [tx] = Object.values(r.engine.transactions.getState().txs);
      expect(tx?.state).toBe("confirmed");
    } finally {
      resetMock();
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });

  it("signs a sponsored transaction in its own slot, sponsor's signature untouched", async () => {
    const r = await rig();
    try {
      const account = await connect(r);
      const input = await wire({
        feePayer: SPONSOR,
        ixs: [transfer(account.address, 1000n)],
        version: 0,
        presign: [await keyPair(SPONSOR_SEED)],
      });
      const { settled, approve } = await call(r, "solana:signTransaction", {
        transactions: [input],
      });
      await approve();
      const signed = signedAt(await settled, 0);
      expect(slotSignature(signed, SPONSOR)).toStrictEqual(slotSignature(input, SPONSOR));
      expect(verifySlot(signed, account.address)).toBe(true);
    } finally {
      r.engine.unsubscribe();
      await r.wallet.destroy();
    }
  });
});
