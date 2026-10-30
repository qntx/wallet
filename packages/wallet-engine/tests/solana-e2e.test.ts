import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { base64 } from "@scure/base";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  getInitializeMintInstruction as initMint22,
  getInitializeNonTransferableMintInstruction,
  getInitializeTransferFeeConfigInstruction,
  getMintSize,
  getMintToCheckedInstruction as mintTo22,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { address as solAddress, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { SolanaChainAdapter } from "../src/chains/solana.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";

const RUN = process.env["ENGINE_E2E_SOLANA"] === "1";
// Official Agave release binary on PATH (or SOLANA_TEST_VALIDATOR); CI installs v3.1.11
// from the anza-xyz/agave release tarball, SHA-256 verified.
const VALIDATOR = process.env["SOLANA_TEST_VALIDATOR"] ?? "solana-test-validator";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const rpc = (url: string): SolanaRpc => ({
  call: async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error !== undefined) {
      throw new Error(body.error.message ?? method);
    }
    return body.result;
  },
});

const ledgerLog = (dir: string): string => {
  try {
    return readFileSync(join(dir, "validator.log"), "utf8");
  } catch {
    return "<no validator.log>";
  }
};

const waitHealthy = async (r: SolanaRpc, dir: string, deadline: number): Promise<void> => {
  try {
    await r.call("getHealth", []);
  } catch {
    if (Date.now() > deadline) {
      throw new Error(`validator never became healthy\n${ledgerLog(dir)}`);
    }
    await sleep(1000);
    return waitHealthy(r, dir, deadline);
  }
  return Promise.resolve();
};

const waitConfirmed = async (
  a: SolanaChainAdapter,
  r: SolanaRpc,
  hash: string,
  deadline: number,
): Promise<string> => {
  const s = await a.status(r, hash);
  if (s === "confirmed" || s === "finalized") {
    return s;
  }
  if (Date.now() > deadline) {
    throw new Error(`${hash} never confirmed`);
  }
  await sleep(1000);
  return waitConfirmed(a, r, hash, deadline);
};

const sign = async (
  payer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  message: Uint8Array,
  extra: ReadonlyArray<Awaited<ReturnType<typeof generateKeyPairSigner>>> = [],
): Promise<ReadonlyArray<Uint8Array>> => {
  const signers = [payer, ...extra];
  const results = await Promise.all(
    signers.map(async (s) => s.signMessages([{ content: message, signatures: {} }])),
  );
  return signers.map((s, i) => {
    const dict = (Array.isArray(results[i]) ? results[i][0] : results[i]) as Record<
      string,
      Uint8Array
    >;
    const sig = dict[s.address];
    if (sig === undefined || sig.length !== 64) {
      throw new Error(`no signature for ${s.address}`);
    }
    return sig;
  });
};

const send = async (
  a: SolanaChainAdapter,
  r: SolanaRpc,
  payer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  unsigned: Parameters<SolanaChainAdapter["applyFee"]>[0],
  extra: ReadonlyArray<Awaited<ReturnType<typeof generateKeyPairSigner>>> = [],
): Promise<string> => {
  const message = a.applyFee(unsigned, { tier: "normal", microLamportsPerCu: 0n });
  const wire = a.finalize(message, await sign(payer, message, extra));
  return a.broadcast(r, wire);
};

const balance = (v: unknown): number => {
  const o = typeof v === "object" && v !== null ? (v as { value?: unknown }).value : undefined;
  return typeof o === "number" ? o : 0;
};

const waitFunded = async (r: SolanaRpc, addr: string, deadline: number): Promise<void> => {
  const bal = await r.call("getBalance", [addr, { commitment: "confirmed" }]);
  if (balance(bal) > 0) {
    return;
  }
  if (Date.now() > deadline) {
    throw new Error("airdrop never landed");
  }
  await r
    .call("requestAirdrop", [addr, 10_000_000_000, { commitment: "confirmed" }])
    .catch(() => "");
  await sleep(1000);
  return waitFunded(r, addr, deadline);
};

const waitBuild = async (
  a: SolanaChainAdapter,
  r: SolanaRpc,
  network: string,
  from: string,
  to: string,
  deadline: number,
): ReturnType<SolanaChainAdapter["build"]> => {
  try {
    return await a.build(r, network, from, { kind: "sol", to, lamports: 1_000_000n });
  } catch (error) {
    if (Date.now() > deadline) {
      throw error;
    }
    await sleep(1000);
    return waitBuild(a, r, network, from, to, deadline);
  }
};

describe.runIf(RUN)("solana e2e: local validator", () => {
  it("airdrops, transfers SOL, creates a mint, transfers SPL — balances and statuses check out", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "sol-e2e-"));
    const validator = spawn(
      VALIDATOR,
      ["--reset", "--ledger", ledger, "--quiet", "--bind-address", "127.0.0.1"],
      { stdio: "ignore" },
    );
    try {
      const url = "http://127.0.0.1:8899";
      const r = rpc(url);
      await waitHealthy(r, ledger, Date.now() + 120_000);
      const payer = await generateKeyPairSigner();
      const recipient = await generateKeyPairSigner();
      const a = new SolanaChainAdapter();
      await waitFunded(r, payer.address, Date.now() + 120_000);

      const unsigned = await waitBuild(
        a,
        r,
        NETWORK,
        payer.address,
        recipient.address,
        Date.now() + 60_000,
      );
      const solHash = await send(a, r, payer, unsigned);
      await waitConfirmed(a, r, solHash, Date.now() + 60_000);
      await expect(a.status(r, solHash)).resolves.toMatch(/confirmed|finalized/);
      const recipientBal = (await r.call("getBalance", [
        recipient.address,
        { commitment: "confirmed" },
      ])) as { value: number };
      expect(recipientBal.value).toBe(1_000_000);

      const mint = await generateKeyPairSigner();
      const rent = (await r.call("getMinimumBalanceForRentExemption", [
        82,
        { commitment: "confirmed" },
      ])) as number;
      const [mintAta] = await findAssociatedTokenPda({
        mint: mint.address,
        owner: payer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const mintHash = await send(
        a,
        r,
        payer,
        {
          family: "solana",
          network: NETWORK,
          from: payer.address,
          instructions: [
            getCreateAccountInstruction({
              payer,
              newAccount: mint,
              lamports: BigInt(rent),
              space: 82n,
              programAddress: TOKEN_PROGRAM_ADDRESS,
            }),
            getInitializeMintInstruction({
              mint: mint.address,
              decimals: 6,
              mintAuthority: payer.address,
            }),
            getCreateAssociatedTokenIdempotentInstruction({
              ata: mintAta,
              mint: mint.address,
              owner: payer.address,
              payer,
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
            getMintToCheckedInstruction({
              mint: mint.address,
              token: mintAta,
              mintAuthority: payer,
              amount: 1_000_000_000n,
              decimals: 6,
            }),
          ],
          writable: [],
          unitsConsumed: 0,
          blockhash: unsigned.blockhash,
          lastValidBlockHeight: unsigned.lastValidBlockHeight,
        },
        [mint],
      );
      await waitConfirmed(a, r, mintHash, Date.now() + 60_000);
      await expect(a.status(r, mintHash)).resolves.toMatch(/confirmed|finalized/);

      const splUnsigned = await a.build(r, NETWORK, payer.address, {
        kind: "spl",
        mint: mint.address,
        to: recipient.address,
        amount: 500_000n,
        decimals: 6,
      });
      const splHash = await send(a, r, payer, splUnsigned);
      await waitConfirmed(a, r, splHash, Date.now() + 60_000);
      await expect(a.status(r, splHash)).resolves.toMatch(/confirmed|finalized/);
      const [destAta] = await findAssociatedTokenPda({
        mint: mint.address,
        owner: recipient.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ataBal = (await r.call("getTokenAccountBalance", [
        destAta,
        { commitment: "confirmed" },
      ])) as { value: { amount: string } };
      expect(ataBal.value.amount).toBe("500000");
    } finally {
      validator.kill("SIGKILL");
      spawnSync("pkill", ["-f", VALIDATOR]);
      rmSync(ledger, { recursive: true, force: true });
    }
  }, 300_000);
});

const taggedRandom = (): ((n: number) => Uint8Array) => {
  let tag = 0;
  return (n) => {
    tag += 1;
    return new Uint8Array(n).fill(tag);
  };
};

const BPASS = "e2e-token2022";
const BVERIFY = { kind: "password" as const, password: BPASS };
const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);

const solFrom = (acct: unknown): string => {
  const o = typeof acct === "object" && acct !== null ? (acct as Record<string, unknown>) : {};
  return typeof o["address"] === "string" ? o["address"] : "";
};

const txHashOf = (tx: { readonly hash: string | undefined }): string => tx.hash ?? "";

const realWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
  const wallet = await createNodeWallet({
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
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    factor: { kind: "password", password: BPASS },
  });
  return { wallet, walletId: info.walletId };
};

const t22MintSetup = async (
  r: SolanaRpc,
  payer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  owner: string,
  kind: "transferFee" | "nonTransferable",
): Promise<{ mint: Awaited<ReturnType<typeof generateKeyPairSigner>>; ata: string }> => {
  const a = new SolanaChainAdapter();
  const mint = await generateKeyPairSigner();
  const [ata] = await findAssociatedTokenPda({
    mint: mint.address,
    owner: solAddress(owner),
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const size =
    kind === "transferFee"
      ? getMintSize([
          {
            __kind: "TransferFeeConfig",
            transferFeeConfigAuthority: payer.address,
            withdrawWithheldAuthority: payer.address,
            withheldAmount: 0,
            olderTransferFee: { epoch: 0, maximumFee: 1_000_000, transferFeeBasisPoints: 100 },
            newerTransferFee: { epoch: 0, maximumFee: 1_000_000, transferFeeBasisPoints: 100 },
          },
        ])
      : getMintSize([{ __kind: "NonTransferable" }]);
  const rent = (await r.call("getMinimumBalanceForRentExemption", [
    size,
    { commitment: "confirmed" },
  ])) as number;
  const bootstrap = await waitBuild(
    a,
    r,
    NETWORK,
    payer.address,
    payer.address,
    Date.now() + 60_000,
  );
  const init22 = [
    kind === "transferFee"
      ? getInitializeTransferFeeConfigInstruction({
          mint: mint.address,
          transferFeeConfigAuthority: payer.address,
          withdrawWithheldAuthority: payer.address,
          transferFeeBasisPoints: 100,
          maximumFee: 1_000_000n,
        })
      : getInitializeNonTransferableMintInstruction({ mint: mint.address }),
    initMint22({
      mint: mint.address,
      decimals: 6,
      mintAuthority: payer.address,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      ata,
      mint: mint.address,
      owner: solAddress(owner),
      payer,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    mintTo22({
      mint: mint.address,
      token: ata,
      mintAuthority: payer,
      amount: 1_000_000_000n,
      decimals: 6,
    }),
  ];
  const wire = a.applyFee(
    {
      family: "solana",
      network: NETWORK,
      from: payer.address,
      instructions: [
        getCreateAccountInstruction({
          payer,
          newAccount: mint,
          lamports: BigInt(rent),
          space: BigInt(size),
          programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        }),
        ...init22,
      ],
      writable: [],
      unitsConsumed: 0,
      blockhash: bootstrap.blockhash,
      lastValidBlockHeight: bootstrap.lastValidBlockHeight,
    },
    { tier: "normal", microLamportsPerCu: 0n },
  );
  const rawWire = a.finalize(wire, await sign(payer, wire, [mint]));
  const simRaw = (await r.call("simulateTransaction", [
    base64.encode(rawWire),
    { encoding: "base64", commitment: "confirmed", sigVerify: true },
  ])) as { value: { err?: unknown; logs?: string[] | null } };
  process.stderr.write(
    `\nT22SIM_ERR=${JSON.stringify(simRaw.value.err)}\nT22SIM_LOGS=${(simRaw.value.logs ?? []).join("\n").slice(-900)}\n`,
  );
  const hash = (await r.call("sendTransaction", [
    base64.encode(rawWire),
    { encoding: "base64", skipPreflight: true },
  ])) as string;
  await sleep(2000);
  const st = (await r.call("getSignatureStatuses", [[hash]])) as {
    value: Array<{ err?: unknown; confirmationStatus?: string } | null>;
  };
  const err = st.value[0]?.err;
  if (err !== null && err !== undefined) {
    throw new Error(`mint setup tx failed: ${JSON.stringify(err)}`);
  }
  await sleep(4000);
  const st2 = (await r.call("getSignatureStatuses", [
    [hash],
    { searchTransactionHistory: true },
  ])) as {
    value: unknown[];
  };
  process.stderr.write(`\nT22STATUS=${JSON.stringify(st2.value[0]).slice(0, 600)}\n`);
  await waitConfirmed(a, r, hash, Date.now() + 60_000);
  return { mint, ata };
};

describe.runIf(RUN)("solana e2e: token-2022 through engine.transactions", () => {
  it("sends a TransferFeeConfig mint (net received) and rejects NonTransferable", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "sol-t22-"));
    const validator = spawn(
      VALIDATOR,
      ["--reset", "--ledger", ledger, "--quiet", "--bind-address", "127.0.0.1"],
      { stdio: "ignore" },
    );
    try {
      const url = "http://127.0.0.1:8899";
      const r = rpc(url);
      await waitHealthy(r, ledger, Date.now() + 120_000);
      const payer = await generateKeyPairSigner();
      const recipient = await generateKeyPairSigner();
      const a = new SolanaChainAdapter();
      await waitFunded(r, payer.address, Date.now() + 120_000);

      const { wallet, walletId } = await realWallet();
      const acct = await chains(wallet).account({
        walletId,
        groupIndex: 0,
        template: "solana.bip44-change",
        network: NETWORK,
      });
      const from = solFrom(acct);
      await waitFunded(r, from, Date.now() + 120_000);

      const timers: Array<() => unknown> = [];
      const ctl = new TransactionController({
        wallet,
        networks: new NetworkController({
          fetch: globalThis.fetch.bind(globalThis),
          rpc: { [NETWORK]: [url] },
          openStore: async () => Promise.resolve(createMemoryEngineStore()),
          logger: { warn: () => {} },
        }),
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        random: taggedRandom(),
        setTimer: (_ms, fn) => {
          timers.push(fn);
          return () => {};
        },
        now: () => 1000,
        logger: { warn: () => {} },
        pollMs: 1,
      });
      await ctl.init();

      const feeMint = await t22MintSetup(r, payer, from, "transferFee");
      const tx = await ctl.send({
        account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
        network: NETWORK,
        to: recipient.address,
        amount: 500_000n,
        token: feeMint.mint.address,
        decimals: 6,
        fee: "slow",
        verify: BVERIFY,
      });
      expect(tx.state).toBe("submitted");
      await waitConfirmed(a, r, txHashOf(tx), Date.now() + 120_000);
      const [destAta] = await findAssociatedTokenPda({
        mint: feeMint.mint.address,
        owner: recipient.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });
      const destBal = (await r.call("getTokenAccountBalance", [
        destAta,
        { commitment: "confirmed" },
      ])) as { value: { amount: string } };
      // 100 bps of 500_000 = 5_000 withheld → recipient gets 495_000.
      expect(destBal.value.amount).toBe("495000");

      expect(tx.intent?.outflows[0]?.amount.amount).toBe("495000");

      const ntMint = await t22MintSetup(r, payer, from, "nonTransferable");
      await expect(
        ctl.send({
          account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
          network: NETWORK,
          to: recipient.address,
          amount: 1000n,
          token: ntMint.mint.address,
          decimals: 6,
          fee: "slow",
          verify: BVERIFY,
        }),
      ).rejects.toThrow(/non-transferable/);
    } finally {
      validator.kill("SIGKILL");
      spawnSync("pkill", ["-f", VALIDATOR]);
      rmSync(ledger, { recursive: true, force: true });
    }
  }, 300_000);
});
