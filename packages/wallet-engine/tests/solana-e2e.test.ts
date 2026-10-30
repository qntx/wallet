import { execFileSync } from "node:child_process";

import { getCreateAccountInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getInitializeMintInstruction,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { SolanaChainAdapter } from "../src/chains/solana.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";

const RUN = process.env["ENGINE_E2E_SOLANA"] === "1";
// Official Anza image, pinned by digest (amd64-only; runs under emulation on arm64 hosts).
const IMAGE =
  "anzaxyz/agave:v3.1.11@sha256:d6440a53f2ca6172172f87cf0d2ea54e6a98a99b0ea1739962a0dbc40727b758";
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

const logs = (name: string): string => {
  try {
    const ps = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}} {{.Status}}"]).toString();
    const out = execFileSync("docker", ["logs", name]).toString();
    const file = execFileSync("docker", ["exec", name, "tail", "-200", "/tmp/ledger/validator.log"]).toString();
    return `${ps}
--- docker logs ---
${out}
--- validator.log ---
${file}`;
  } catch {
    return "<no logs>";
  }
};

const PORT = "18899";

const waitHealthy = async (r: SolanaRpc, name: string, deadline: number): Promise<void> => {
  try {
    await r.call("getHealth", []);
  } catch {
    if (Date.now() > deadline) {
      throw new Error(`validator never became healthy\n${logs(name)}`);
    }
    await sleep(1000);
    return waitHealthy(r, name, deadline);
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

const startValidator = (name: string): void => {
  execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  execFileSync("docker", ["pull", "--platform", "linux/amd64", IMAGE], { stdio: "inherit" });
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--platform",
      "linux/amd64",
      "--entrypoint",
      "solana-test-validator",
      "--name",
      name,
      "-p",
      `${PORT}:8899`,
      IMAGE,
      "--reset",
      "--ledger",
      "/tmp/ledger",
      "--rpc-bind-address",
      "0.0.0.0",
    ],
    { stdio: "pipe" },
  );
};

const sign = async (
  payer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  message: Uint8Array,
): Promise<Uint8Array> => {
  const sigs = await payer.signMessages([{ content: message, signatures: {} }]);
  return sigs[0]?.[payer.address] ?? new Uint8Array();
};

const send = async (
  a: SolanaChainAdapter,
  r: SolanaRpc,
  payer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  unsigned: Parameters<SolanaChainAdapter["applyFee"]>[0],
): Promise<string> => {
  const message = a.applyFee(unsigned, { tier: "normal", microLamportsPerCu: 0n });
  const wire = a.finalize(message, await sign(payer, message));
  return a.broadcast(r, wire);
};

describe.runIf(RUN)("solana e2e: local validator", () => {
  it("airdrops, transfers SOL, creates a mint, transfers SPL — balances and statuses check out", async () => {
    const name = `solana-e2e-${Date.now()}`;
    startValidator(name);
    try {
      const url = `http://127.0.0.1:${PORT}`;
      const r = rpc(url);
      await waitHealthy(r, name, Date.now() + 240_000);
      const payer = await generateKeyPairSigner();
      const recipient = await generateKeyPairSigner();
      const a = new SolanaChainAdapter();
      await r.call("requestAirdrop", [payer.address, 10_000_000_000, { commitment: "confirmed" }]);
      await sleep(3000);

      const unsigned = await a.build(r, NETWORK, payer.address, {
        kind: "sol",
        to: recipient.address,
        lamports: 1_000_000n,
      });
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
      const mintHash = await send(a, r, payer, {
        family: "solana",
        network: NETWORK,
        from: payer.address,
        instructions: [
          getCreateAccountInstruction({
            payer,
            newAccount: mint,
            lamports: BigInt(rent),
            space: 82n,
            programAddress: SYSTEM_PROGRAM_ADDRESS,
          }),
          getInitializeMintInstruction({
            mint: mint.address,
            decimals: 6,
            mintAuthority: payer.address,
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
      });
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
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    }
  }, 300_000);
});
