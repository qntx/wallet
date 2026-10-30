import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { SolanaChainAdapter } from "../src/chains/solana.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";

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
    const { killed } = validator;
    try {
      const url = "http://127.0.0.1:8899";
      const r = rpc(url);
      if (!killed && validator.exitCode !== null) {
        throw new Error(`validator exited ${validator.exitCode}\n${ledgerLog(ledger)}`);
      }
      await waitHealthy(r, ledger, Date.now() + 120_000);
      const payer = await generateKeyPairSigner();
      const recipient = await generateKeyPairSigner();
      const a = new SolanaChainAdapter();
      const waitFunded = async (deadline: number): Promise<void> => {
        const bal = await r.call("getBalance", [payer.address, { commitment: "confirmed" }]);
        const v =
          typeof bal === "object" && bal !== null ? ((bal as { value?: number }).value ?? 0) : 0;
        if (v > 0) {
          return;
        }
        if (Date.now() > deadline) {
          throw new Error("airdrop never landed");
        }
        // The faucet isn't credited until genesis settles — retry the request itself.
        await r
          .call("requestAirdrop", [payer.address, 10_000_000_000, { commitment: "confirmed" }])
          .catch(() => "");
        await sleep(1000);
        return waitFunded(deadline);
      };
      await waitFunded(Date.now() + 120_000);

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
