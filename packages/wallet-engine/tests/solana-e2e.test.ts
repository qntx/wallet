import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { base64 } from "@scure/base";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getApproveInstruction,
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
import {
  AccountRole,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  address as solAddress,
  generateKeyPairSigner,
  getAddressEncoder,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { ApprovalsController } from "../src/approvals/controller.ts";
import { metaplexMetadataAddress } from "../src/chains/nfts.ts";
import { SolanaChainAdapter } from "../src/chains/solana.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import type { RequestController } from "../src/requests/controller.ts";
import { stakePositions } from "../src/staking/index.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { ChainRequestInput, TrackedTransaction } from "../src/transactions/route.ts";
import { approval } from "./approval.ts";
import { send as sendTx, idleNetworkDeps, requestsFor } from "./send-helpers.ts";

const RUN = process.env["ENGINE_E2E_SOLANA"] === "1";
// Official Agave release binary on PATH (or SOLANA_TEST_VALIDATOR); CI installs v4.4.0
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
  const { entry } = await a.signatureStatus(r, hash);
  if (entry !== undefined && entry.commitment !== "processed" && !entry.failed) {
    return entry.commitment;
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
  await sleep(250);
  return waitUntil(check, deadline);
};

const mustFind = <T>(list: ReadonlyArray<T>, pred: (item: T) => boolean, name: string): T => {
  const found = list.find(pred);
  if (found === undefined) {
    throw new Error(`expected ${name} missing`);
  }
  return found;
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
      const solSimulation = await a.simulate(
        r,
        NETWORK,
        payer.address,
        a.applyFee(unsigned, { tier: "normal", microLamportsPerCu: 0n }),
        realTimer,
      );
      // The simulation deducts the 5000-lamport base fee: -(amount + fee).
      expect(solSimulation).toStrictEqual({
        status: "success",
        changes: [{ asset: "lamports", amount: "-1005000", verified: true }],
      });
      const solHash = await send(a, r, payer, unsigned);
      await waitConfirmed(a, r, solHash, Date.now() + 60_000);
      await expect(a.signatureStatus(r, solHash)).resolves.toMatchObject({
        entry: expect.objectContaining({
          commitment: expect.stringMatching(/confirmed|finalized/),
        }),
      });
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
      await expect(a.signatureStatus(r, mintHash)).resolves.toMatchObject({
        entry: expect.objectContaining({
          commitment: expect.stringMatching(/confirmed|finalized/),
        }),
      });

      const splUnsigned = await a.build(r, NETWORK, payer.address, {
        kind: "spl",
        mint: mint.address,
        to: recipient.address,
        amount: 500_000n,
        decimals: 6,
      });
      const splSimulation = await a.simulate(
        r,
        NETWORK,
        payer.address,
        a.applyFee(splUnsigned, { tier: "normal", microLamportsPerCu: 0n }),
        realTimer,
      );
      // Lamports: the base fee plus the recipient token account's rent; the token: -amount.
      expect(splSimulation).toStrictEqual({
        status: "success",
        changes: [
          { asset: "lamports", amount: "-2044280", verified: true },
          { asset: mint.address, amount: "-500000", verified: false },
        ],
      });
      const splHash = await send(a, r, payer, splUnsigned);
      await waitConfirmed(a, r, splHash, Date.now() + 60_000);
      await expect(a.signatureStatus(r, splHash)).resolves.toMatchObject({
        entry: expect.objectContaining({
          commitment: expect.stringMatching(/confirmed|finalized/),
        }),
      });
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

const waitVoteAccount = async (r: SolanaRpc, deadline: number): Promise<string> => {
  const votes = (await r.call("getVoteAccounts", [])) as {
    current: Array<{ votePubkey: string }>;
  };
  const vote = votes.current[0]?.votePubkey;
  if (vote !== undefined) {
    return vote;
  }
  if (Date.now() > deadline) {
    throw new Error("validator exposes no vote account");
  }
  await sleep(2000);
  return waitVoteAccount(r, deadline);
};

const waitEpochAdvanced = async (r: SolanaRpc, target: bigint, deadline: number): Promise<void> => {
  /* The stake program rejects deactivate/withdraw while epoch rewards are being
     distributed — wait a few slots into the new epoch, not just for the boundary. */
  const info = (await r.call("getEpochInfo", [])) as {
    epoch: number;
    slotIndex: number;
    slotsInEpoch: number;
  };
  if (BigInt(info.epoch) > target && info.slotIndex >= 8) {
    return;
  }
  if (Date.now() > deadline) {
    throw new Error("epoch never advanced");
  }
  await sleep(2000);
  return waitEpochAdvanced(r, target, deadline);
};

type StakeRun = (
  action: Extract<ChainRequestInput, { method: "solana-stake" }>["action"],
) => Promise<TrackedTransaction>;

const stakeAction = async (
  requests: RequestController,
  a: SolanaChainAdapter,
  r: SolanaRpc,
  account: Extract<ChainRequestInput, { method: "solana-stake" }>["account"],
  action: Extract<ChainRequestInput, { method: "solana-stake" }>["action"],
) => {
  const pending = await requests.prepare({
    method: "solana-stake",
    account,
    network: NETWORK,
    action,
    fee: "slow",
  });
  const tx = await requests.approve(pending.id, "solana-stake", approval(pending, BVERIFY));
  await waitConfirmed(a, r, txHashOf(tx), Date.now() + 120_000);
  return tx;
};

/* Rewards accrue until cooldown ends — withdraw whatever is left until the account
   reads empty (a deleted account and a drained husk both report zero lamports). */
const withdrawStakeAll = async (
  run: StakeRun,
  r: SolanaRpc,
  stakeAccount: string,
  attempt: number,
): Promise<void> => {
  if (attempt >= 5) {
    return;
  }
  const balance = (await r.call("getBalance", [stakeAccount, { commitment: "confirmed" }])) as {
    value: number;
  };
  if (balance.value === 0) {
    return;
  }
  await run({ kind: "withdraw", stakeAccount, lamports: BigInt(balance.value) });
  return withdrawStakeAll(run, r, stakeAccount, attempt + 1);
};

const NFT_ACCOUNTS = JSON.parse(
  readFileSync(new URL("fixtures/nfts/solana-mainnet-accounts.json", import.meta.url), "utf8"),
) as {
  readonly owner: string;
  readonly plain: {
    readonly mint: { readonly address: string; readonly response: { value: unknown } };
    readonly metadata: { readonly address: string; readonly response: { value: unknown } };
    readonly ata: { readonly address: string; readonly response: { value: unknown } };
  };
};

/** The `solana-test-validator --account <address> <file>` dump shape from a fixture response. */
const accountDump = (address: string, value: unknown): string => {
  /* The captured `rentEpoch` is u64::MAX rounded by JSON (…52000 overflows u64);
     the dumped `space` field is not part of the account-dump shape either. */
  const { space: _space, rentEpoch: _rentEpoch, ...rest } = value as Record<string, unknown>;
  return JSON.stringify({ pubkey: address, account: { ...rest, rentEpoch: 0 } });
};

/** A 165-byte SPL token account: mint @0, owner @32, amount u64LE @64, state u8 @108. */
const tokenAccountDump = (
  address: string,
  mint: string,
  owner: string,
  amount: bigint,
  lamports: number,
): string =>
  JSON.stringify({
    pubkey: address,
    account: {
      lamports,
      data: [
        base64.encode(
          (() => {
            const b = new Uint8Array(165);
            b.set(getAddressEncoder().encode(solAddress(mint)), 0);
            b.set(getAddressEncoder().encode(solAddress(owner)), 32);
            new DataView(b.buffer).setBigUint64(64, amount, true);
            b[108] = 1; // initialized
            return b;
          })(),
        ),
        "base64",
      ],
      owner: TOKEN_PROGRAM_ADDRESS,
      executable: false,
      rentEpoch: 0,
    },
  });

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
      [
        "--reset",
        "--ledger",
        ledger,
        "--quiet",
        "--bind-address",
        "127.0.0.1",
        "--rpc-port",
        "8898",
        "--faucet-port",
        "9908",
      ],
      { stdio: "ignore" },
    );
    try {
      const url = "http://127.0.0.1:8898";
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

      const ctl = new TransactionController({
        wallet,
        networks: new NetworkController({
          ...idleNetworkDeps,
          fetch: globalThis.fetch.bind(globalThis),
          rpc: { [NETWORK]: [url] },
          openStore: async () => Promise.resolve(createMemoryEngineStore()),
          logger: { warn: () => {} },
        }),
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        random: taggedRandom(),
        setTimer: () => () => {},
        now: () => 1000,
        logger: { warn: () => {} },
        pollMs: 1,
      });
      await ctl.init();

      const feeMint = await t22MintSetup(r, payer, from, "transferFee");
      const tx = await sendTx(ctl, {
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
        sendTx(ctl, {
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

  it("stakes natively: delegate → activate → deactivate → withdraw through the pipeline", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "sol-stake-"));
    const validator = spawn(
      VALIDATOR,
      [
        "--reset",
        "--ledger",
        ledger,
        "--quiet",
        "--bind-address",
        "127.0.0.1",
        "--rpc-port",
        "8897",
        "--faucet-port",
        "9907",
        "--slots-per-epoch",
        "32",
      ],
      { stdio: "ignore" },
    );
    try {
      const url = "http://127.0.0.1:8897";
      const r = rpc(url);
      await waitHealthy(r, ledger, Date.now() + 120_000);
      const a = new SolanaChainAdapter();
      const { wallet, walletId } = await realWallet();
      const acct = await chains(wallet).account({
        walletId,
        groupIndex: 0,
        template: "solana.bip44-change",
        network: NETWORK,
      });
      const from = solFrom(acct);
      await waitFunded(r, from, Date.now() + 120_000);
      const vote = await waitVoteAccount(r, Date.now() + 120_000);
      const min = BigInt(
        (
          (await r.call("getStakeMinimumDelegation", [{ commitment: "confirmed" }])) as {
            value: number | string;
          }
        ).value,
      );
      const ctl = new TransactionController({
        wallet,
        networks: new NetworkController({
          ...idleNetworkDeps,
          fetch: globalThis.fetch.bind(globalThis),
          rpc: { [NETWORK]: [url] },
          openStore: async () => Promise.resolve(createMemoryEngineStore()),
          logger: { warn: () => {} },
        }),
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        random: taggedRandom(),
        setTimer: () => () => {},
        now: () => 1000,
        logger: { warn: () => {} },
        pollMs: 1,
      });
      await ctl.init();
      const requests = await requestsFor(ctl);
      const account = {
        kind: "hd" as const,
        walletId,
        groupIndex: 0,
        template: "solana.bip44-change" as const,
      };
      const run = async (
        action: Extract<ChainRequestInput, { method: "solana-stake" }>["action"],
      ) => stakeAction(requests, a, r, account, action);

      const lamports = min;
      const delegateTx = await run({ kind: "delegate", lamports, vote });
      expect(delegateTx.intent?.summary).toBe("stake");
      const createAction = delegateTx.intent?.staking?.[0];
      // oxlint-disable-next-line vitest/no-conditional-in-test -- narrowing check
      const stakeAccount = createAction?.kind === "create" ? createAction.account : undefined;
      // oxlint-disable-next-line vitest/no-conditional-in-test -- narrowing check
      if (stakeAccount === undefined) {
        throw new Error("delegate intent carries no stake account");
      }
      const first = await stakePositions(r, from);
      expect(first.map((p) => [p.address, p.state])).toStrictEqual([[stakeAccount, "activating"]]);

      await waitEpochAdvanced(r, first[0]!.activationEpoch!, Date.now() + 240_000);
      const active = await stakePositions(r, from);
      expect(active.map((p) => p.state)).toStrictEqual(["active"]);

      await run({ kind: "deactivate", stakeAccount });
      const cooling = await stakePositions(r, from);
      expect(cooling.map((p) => p.state)).toStrictEqual(["deactivating"]);

      await waitEpochAdvanced(r, cooling[0]!.deactivationEpoch!, Date.now() + 240_000);
      const inactive = await stakePositions(r, from);
      expect(inactive.map((p) => p.state)).toStrictEqual(["inactive"]);

      await withdrawStakeAll(run, r, stakeAccount, 0);
      await expect(stakePositions(r, from)).resolves.toStrictEqual([]);
    } finally {
      validator.kill("SIGKILL");
      spawnSync("pkill", ["-f", VALIDATOR]);
      rmSync(ledger, { recursive: true, force: true });
    }
  }, 600_000);
});

describe.runIf(RUN)("solana e2e: approvals inventory and revocation", () => {
  it("lists an SPL delegate and revokes it through the pipeline", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "sol-appr-"));
    const validator = spawn(
      VALIDATOR,
      [
        "--reset",
        "--ledger",
        ledger,
        "--quiet",
        "--bind-address",
        "127.0.0.1",
        "--rpc-port",
        "8896",
        "--faucet-port",
        "9906",
      ],
      { stdio: "ignore" },
    );
    try {
      const url = "http://127.0.0.1:8896";
      const r = rpc(url);
      await waitHealthy(r, ledger, Date.now() + 120_000);
      const payer = await generateKeyPairSigner();
      const delegateSigner = await generateKeyPairSigner();
      const delegate = delegateSigner.address;
      const a = new SolanaChainAdapter();
      await waitFunded(r, payer.address, Date.now() + 120_000);

      const { wallet, walletId } = await realWallet();
      const hdAccount = {
        kind: "hd" as const,
        walletId,
        groupIndex: 0,
        template: "solana.bip44-change" as const,
      };
      const acct = await chains(wallet).account({
        walletId,
        groupIndex: 0,
        template: hdAccount.template,
        network: NETWORK,
      });
      const from = solAddress(solFrom(acct));
      await waitFunded(r, from, Date.now() + 120_000);

      /* Mint + a funded token account owned by the wallet — the setup payer signs all of it. */
      const mint = await generateKeyPairSigner();
      const rent = (await r.call("getMinimumBalanceForRentExemption", [
        82,
        { commitment: "confirmed" },
      ])) as number;
      const [ata] = await findAssociatedTokenPda({
        mint: mint.address,
        owner: from,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const unsigned = await waitBuild(
        a,
        r,
        NETWORK,
        payer.address,
        payer.address,
        Date.now() + 60_000,
      );
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
              ata,
              mint: mint.address,
              owner: from,
              payer,
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
            getMintToCheckedInstruction({
              mint: mint.address,
              token: ata,
              mintAuthority: payer,
              amount: 1_000_000n,
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

      /* The SPL Approve must come from the wallet itself — kernel normalize → decode → sign. */
      const lifetime = (await r.call("getLatestBlockhash", [{ commitment: "confirmed" }])) as {
        value: { blockhash: string; lastValidBlockHeight: number };
      };
      const message = new Uint8Array(
        getCompiledTransactionMessageEncoder().encode(
          compileTransactionMessage(
            setTransactionMessageLifetimeUsingBlockhash(
              {
                blockhash: blockhash(lifetime.value.blockhash),
                lastValidBlockHeight: BigInt(lifetime.value.lastValidBlockHeight),
              },
              setTransactionMessageFeePayer(
                from,
                appendTransactionMessageInstructions(
                  [
                    getApproveInstruction({
                      source: ata,
                      delegate,
                      owner: from,
                      amount: 500_000n,
                    }),
                  ],
                  setTransactionMessageConfig(
                    {
                      priorityFeeLamports: 5000n,
                      computeUnitLimit: 1_400_000,
                      loadedAccountsDataSizeLimit: 32 * 1024 * 1024,
                    },
                    createTransactionMessage({ version: 1 }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      const signed = await chains(wallet).sign({
        request: {
          kind: "solana.transaction",
          network: NETWORK,
          account: hdAccount,
          message,
        },
        verify: BVERIFY,
      });
      const { signature } = signed as Extract<typeof signed, { kind: "solana.transaction" }>;
      expect(signature).toHaveLength(64);
      const approveHash = await a.broadcast(r, a.finalize(message, [signature]));
      await waitConfirmed(a, r, approveHash, Date.now() + 60_000);

      const networks = new NetworkController({
        ...idleNetworkDeps,
        fetch: globalThis.fetch.bind(globalThis),
        rpc: { [NETWORK]: [url] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      });
      const transactions = new TransactionController({
        wallet,
        networks,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        random: taggedRandom(),
        setTimer: realTimer,
        now: () => Date.now(),
        logger: { warn: () => {} },
        pollMs: 200,
      });
      await transactions.init();
      const requests = await requestsFor(transactions);
      const approvals = new ApprovalsController({
        networks,
        transactions,
        gateway: undefined,
        fetch: globalThis.fetch,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        setTimer: realTimer,
        now: () => Date.now(),
        logger: { warn: () => {} },
        addressOf: async (ref, network) => transactions.addressOf(ref, network),
        known: () => [],
        tokenMetadata: async () => Promise.resolve({ symbol: "TST", decimals: 6 }),
        sessions: async () => Promise.resolve([]),
        prepare: async (input) => requests.prepare(input),
      });
      await approvals.init();

      const key = await approvals.load(hdAccount, NETWORK);
      const view = () =>
        mustFind(Object.values(approvals.getState().views), (v) => v.key === key, "view");
      await waitUntil(() => view().status === "ready");
      /* Solana has no gateway scan — the delegate row comes from the chain enumeration. */
      expect(view().sources.map((s) => s.source)).toStrictEqual(["local"]);
      const delegateRow = mustFind(
        view().rows,
        (row) => row.kind === "spl-delegate",
        "spl-delegate row",
      );
      expect(delegateRow).toMatchObject({
        kind: "spl-delegate",
        tokenAccount: ata,
        delegate,
        amount: "500000",
        exposure: "500000",
      });

      const pending = await approvals.revoke(key, delegateRow.id);
      expect(pending.display).toMatchObject({
        approvals: [{ kind: "delegate-revoked", account: ata }],
      });
      const revoked = await requests.approve(
        pending.id,
        "solana-revoke",
        approval(pending, BVERIFY),
      );
      await waitConfirmed(a, r, txHashOf(revoked), Date.now() + 120_000);
      await waitUntil(() => !view().rows.some((row) => row.kind === "spl-delegate"));

      const info = (await r.call("getAccountInfo", [
        ata,
        { encoding: "jsonParsed", commitment: "confirmed" },
      ])) as { value: { data: { parsed: { info: { delegate?: string } } } } };
      expect(info.value.data.parsed.info.delegate).toBeUndefined();
    } finally {
      validator.kill("SIGKILL");
      rmSync(ledger, { recursive: true, force: true });
    }
  }, 420_000);
});

describe.runIf(RUN)("solana e2e: dApp-supplied v1 transactions", () => {
  it("a v1 transfer and a >1232-byte v1 memo land on the local validator", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "sol-v1-"));
    const validator = spawn(
      VALIDATOR,
      [
        "--reset",
        "--ledger",
        ledger,
        "--quiet",
        "--bind-address",
        "127.0.0.1",
        // Ports of its own: the stake validator above uses 8897/9907 and may not have released
        // them when this one starts (CI: "Faucet failed to start: Address already in use").
        "--rpc-port",
        "8894",
        "--faucet-port",
        "9904",
      ],
      { stdio: "ignore" },
    );
    try {
      const url = "http://127.0.0.1:8894";
      const r = rpc(url);
      await waitHealthy(r, ledger, Date.now() + 120_000);
      const recipient = await generateKeyPairSigner();
      const a = new SolanaChainAdapter();

      const { wallet, walletId } = await realWallet();
      const hdAccount = {
        kind: "hd" as const,
        walletId,
        groupIndex: 0,
        template: "solana.bip44-change" as const,
      };
      const acct = await chains(wallet).account({
        walletId,
        groupIndex: 0,
        template: hdAccount.template,
        network: NETWORK,
      });
      const from = solAddress(solFrom(acct));
      await waitFunded(r, from, Date.now() + 120_000);

      const freshLifetime = async () => {
        const result = (await r.call("getLatestBlockhash", [{ commitment: "confirmed" }])) as {
          value: { blockhash: string; lastValidBlockHeight: number };
        };
        return {
          blockhash: blockhash(result.value.blockhash),
          lastValidBlockHeight: BigInt(result.value.lastValidBlockHeight),
        };
      };

      const v1Message = async (instructions: Instruction[]): Promise<Uint8Array> => {
        const lifetime = await freshLifetime();
        /* v1 config values are hard limits, not hints: an unset compute-unit or
           loaded-data limit is a 0 cap, so a landable tx must set them both. The
           memo program's log costs push the big tx past 400k units. */
        const withConfig = setTransactionMessageConfig(
          {
            priorityFeeLamports: 5000n,
            computeUnitLimit: 1_400_000,
            loadedAccountsDataSizeLimit: 32 * 1024 * 1024,
          },
          createTransactionMessage({ version: 1 }),
        );
        const withIx = appendTransactionMessageInstructions(instructions, withConfig);
        const withPayer = setTransactionMessageFeePayer(from, withIx);
        const withLifetime = setTransactionMessageLifetimeUsingBlockhash(lifetime, withPayer);
        return new Uint8Array(
          getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(withLifetime)),
        );
      };

      // The wallet's own sign path — kernel normalize → decode → sign — produces
      // the signature the cluster verifies, not a kit key.
      const sendV1 = async (message: Uint8Array): Promise<string> => {
        const signed = await chains(wallet).sign({
          request: {
            kind: "solana.transaction",
            network: NETWORK,
            account: hdAccount,
            message,
          },
          verify: BVERIFY,
        });
        const { signature } = signed as Extract<typeof signed, { kind: "solana.transaction" }>;
        expect(signature).toHaveLength(64);
        const wire = a.finalize(message, [signature]);
        // The wallet writes the v1 wire message-first: the message bytes are at
        // the head, signatures trail them without a count prefix.
        expect(wire.slice(0, message.length)).toStrictEqual(message);
        expect(wire).toHaveLength(message.length + 64);
        return a.broadcast(r, wire);
      };

      const transferData = new Uint8Array(12);
      const transferView = new DataView(transferData.buffer);
      transferView.setUint32(0, 2, true);
      transferView.setBigUint64(4, 1_000_000n, true);
      const v1Hash = await sendV1(
        await v1Message([
          {
            programAddress: solAddress("11111111111111111111111111111111"),
            accounts: [
              { address: from, role: AccountRole.WRITABLE_SIGNER },
              { address: recipient.address, role: AccountRole.WRITABLE },
            ],
            data: transferData,
          },
        ]),
      );
      await waitConfirmed(a, r, v1Hash, Date.now() + 60_000);
      const recipientBal = (await r.call("getBalance", [
        recipient.address,
        { commitment: "confirmed" },
      ])) as { value: number };
      expect(recipientBal.value).toBe(1_000_000);

      // A v1 transaction is not bound by the legacy 1232-byte packet rule:
      // a ~1100-byte memo payload pushes the wire past it.
      const memoData = new TextEncoder().encode("v".repeat(1100));
      const bigMessage = await v1Message([
        {
          programAddress: solAddress("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
          accounts: [{ address: from, role: AccountRole.WRITABLE_SIGNER }],
          data: memoData,
        },
      ]);
      expect(bigMessage.length + 64).toBeGreaterThan(1232);
      const bigHash = await sendV1(bigMessage);
      await waitConfirmed(a, r, bigHash, Date.now() + 60_000);
      await expect(a.signatureStatus(r, bigHash)).resolves.toMatchObject({
        entry: expect.objectContaining({
          commitment: expect.stringMatching(/confirmed|finalized/),
        }),
      });
    } finally {
      validator.kill("SIGKILL");
      rmSync(ledger, { recursive: true, force: true });
    }
  }, 300_000);

  it("sends a preloaded mainnet SPL NFT to a second address through the pipeline", async () => {
    /* The plain (non-programmable) fixture NFT: real mainnet mint + Metaplex
       metadata bytes, plus a crafted ATA owned by the test wallet holding 1. */
    const { wallet, walletId } = await realWallet();
    const hdAccount = {
      kind: "hd" as const,
      walletId,
      groupIndex: 0,
      template: "solana.bip44-change" as const,
    };
    const acct = await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: hdAccount.template,
      network: NETWORK,
    });
    const owner = solAddress(solFrom(acct));
    const mint = NFT_ACCOUNTS.plain.mint.address;
    const recipient = solAddress((await generateKeyPairSigner()).address);
    const [senderAta] = await findAssociatedTokenPda({
      mint: solAddress(mint),
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [recipientAta] = await findAssociatedTokenPda({
      mint: solAddress(mint),
      owner: recipient,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const metadata = await metaplexMetadataAddress(mint);
    expect(metadata).toBe(NFT_ACCOUNTS.plain.metadata.address);

    const dumps = mkdtempSync(join(tmpdir(), "sol-nft-acct-"));
    writeFileSync(
      join(dumps, "mint.json"),
      accountDump(mint, NFT_ACCOUNTS.plain.mint.response.value),
    );
    writeFileSync(
      join(dumps, "meta.json"),
      accountDump(metadata, NFT_ACCOUNTS.plain.metadata.response.value),
    );
    writeFileSync(join(dumps, "ata.json"), tokenAccountDump(senderAta, mint, owner, 1n, 2039280));

    const ledger = mkdtempSync(join(tmpdir(), "sol-nft-"));
    const validator = spawn(
      VALIDATOR,
      [
        "--reset",
        "--ledger",
        ledger,
        "--quiet",
        "--bind-address",
        "127.0.0.1",
        "--rpc-port",
        "8897",
        "--faucet-port",
        "9907",
        "--account",
        mint,
        join(dumps, "mint.json"),
        "--account",
        metadata,
        join(dumps, "meta.json"),
        "--account",
        senderAta,
        join(dumps, "ata.json"),
      ],
      { stdio: "ignore" },
    );
    try {
      const url = "http://127.0.0.1:8897";
      const r = rpc(url);
      await waitHealthy(r, ledger, Date.now() + 120_000);
      const a = new SolanaChainAdapter();
      await waitFunded(r, owner, Date.now() + 120_000);

      const networks = new NetworkController({
        ...idleNetworkDeps,
        fetch: globalThis.fetch.bind(globalThis),
        rpc: { [NETWORK]: [url] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      });
      const transactions = new TransactionController({
        wallet,
        networks,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        random: taggedRandom(),
        setTimer: realTimer,
        now: () => Date.now(),
        logger: { warn: () => {} },
        pollMs: 200,
      });
      await transactions.init();
      const requests = await requestsFor(transactions);
      /* `waitFunded` confirms the airdrop, but simulation runs against the rooted
         bank — roots lag confirmations, so retry prepare like `waitBuild` does. */
      let pending: Awaited<ReturnType<typeof requests.prepare>>;
      const prepDeadline = Date.now() + 90_000;
      for (;;) {
        try {
          pending = await requests.prepare({
            method: "solana-nft-send",
            account: hdAccount,
            network: NETWORK,
            asset: mint,
            to: recipient,
            fee: "normal",
          });
          break;
        } catch (error) {
          if (Date.now() > prepDeadline) {
            throw new Error(`${String(error)}\n${ledgerLog(ledger)}`, { cause: error });
          }
          await sleep(1000);
        }
      }
      expect(pending.display).toMatchObject({
        outflows: [{ to: recipientAta, amount: { asset: mint, amount: "1" } }],
      });
      const tx = await requests.approve(pending.id, "solana-nft-send", approval(pending, BVERIFY));
      await waitConfirmed(a, r, txHashOf(tx), Date.now() + 120_000);

      const ataAmount = async (account: string): Promise<string> => {
        const bal = (await r.call("getTokenAccountBalance", [
          account,
          { commitment: "confirmed" },
        ])) as { value: { amount: string } };
        return bal.value.amount;
      };
      await expect(ataAmount(recipientAta)).resolves.toBe("1");
      await expect(ataAmount(senderAta)).resolves.toBe("0");

      /* The engine's tracked transaction re-read reports the included send. */
      await waitUntil(() => {
        const tracked = Object.values(transactions.getState().txs).find(
          (t) => t.hash === txHashOf(tx),
        );
        return tracked?.state === "confirmed";
      });
    } finally {
      validator.kill("SIGKILL");
      rmSync(ledger, { recursive: true, force: true });
      rmSync(dumps, { recursive: true, force: true });
    }
  }, 420_000);
});
