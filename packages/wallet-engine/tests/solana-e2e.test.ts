import { execFile, execFileSync } from "node:child_process";

import { generateKeyPairSigner } from "@solana/kit";
import {
  getCreateAccountInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getInitializeMintInstruction,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vite-plus/test";

import { SolanaChainAdapter } from "../src/chains/solana.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";

const RUN = process.env["ENGINE_E2E_SOLANA"] === "1";
const IMAGE = "anzaxyz/agave:v3.1.11";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.runIf(RUN)("solana e2e: local validator", () => {
  it("airdrops, transfers SOL, creates a mint, transfers SPL — balances and statuses check out", async () => {
    const name = `solana-e2e-${Date.now()}`;
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    execFile("docker", [
      "run",
      "-d",
      "--platform",
      "linux/amd64",
      "--name",
      name,
      "-p",
      "0:8899",
      IMAGE,
      "solana-test-validator",
      "--reset",
    ]);
    await sleep(1500);
    try {
      const portOut = execFileSync("docker", ["port", name, "8899"]).toString();
      const port = portOut.trim().split(":").at(-1);
      const url = `http://127.0.0.1:${port}`;
      const r = rpc(url);
      // wait for the validator
      for (let i = 0; i < 40; i += 1) {
        try {
          await r.call("getHealth", []);
          break;
        } catch {
          await sleep(1000);
        }
      }
      const payer = await generateKeyPairSigner();
      const recipient = await generateKeyPairSigner();
      const adapter = new SolanaChainAdapter();
      await r.call("requestAirdrop", [payer.address, 10_000_000_000, { commitment: "confirmed" }]);
      await sleep(1500);
      const bal = await r.call("getBalance", [payer.address, { commitment: "confirmed" }]);
      expect(Number((bal as { value: number }).value)).toBeGreaterThan(0);

      // SOL transfer through the adapter
      const unsigned = await adapter.build(r, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payer.address, {
        kind: "sol",
        to: recipient.address,
        lamports: 1_000_000n,
      });
      const quotes = await adapter.estimateFee(r, unsigned.writable);
      const quote = quotes[1];
      expect(quote).toBeDefined();
      const messageBytes = adapter.applyFee(unsigned, quote ?? { tier: "normal", microLamportsPerCu: 0n });
      const [sig] = await payer.signMessages([
        { content: messageBytes, signatures: {} },
      ]);
      const wire = adapter.finalize(messageBytes, sig?.[payer.address] ?? new Uint8Array());
      const hash = await adapter.broadcast(r, wire);
      for (let i = 0; i < 30; i += 1) {
        const s = await adapter.status(r, hash);
        if (s === "confirmed" || s === "finalized") {
          break;
        }
        await sleep(1000);
      }
      expect(["confirmed", "finalized"]).toContain(await adapter.status(r, hash));
      const recipientBal = await r.call("getBalance", [recipient.address, { commitment: "confirmed" }]);
      expect((recipientBal as { value: number }).value).toBe(1_000_000);

      // SPL mint + transfer through the adapter
      const mint = await generateKeyPairSigner();
      const rent = (await r.call("getMinimumBalanceForRentExemption", [
              { commitment: "confirmed" },
      ])) as number;
      const [mintAta] = await findAssociatedTokenPda({
        mint: mint.address,
        owner: payer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const mintIxs = [
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
      ];
      const mintUnsigned = {
        family: "solana" as const,
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        from: payer.address,
        instructions: mintIxs,
        writable: [],
        unitsConsumed: 0,
        blockhash: unsigned.blockhash,
        lastValidBlockHeight: unsigned.lastValidBlockHeight,
      };
      const mintMsg = adapter.applyFee(mintUnsigned, {
        tier: "normal",
        microLamportsPerCu: 0n,
      });
      const mintSigs = await payer.signMessages([{ content: mintMsg, signatures: {} }]);
      const mintWire = adapter.finalize(mintMsg, mintSigs[0]?.[payer.address] ?? new Uint8Array());
      const mintHash = await adapter.broadcast(r, mintWire);
      for (let i = 0; i < 30; i += 1) {
        const s = await adapter.status(r, mintHash);
        if (s === "confirmed" || s === "finalized") {
          break;
        }
        await sleep(1000);
      }
      expect(["confirmed", "finalized"]).toContain(await adapter.status(r, mintHash));

      const splUnsigned = await adapter.build(
        r,
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        payer.address,
        { kind: "spl", mint: mint.address, to: recipient.address, amount: 500_000n, decimals: 6 },
      );
      const splMsg = adapter.applyFee(splUnsigned, {
        tier: "normal",
        microLamportsPerCu: 0n,
      });
      const splSigs = await payer.signMessages([{ content: splMsg, signatures: {} }]);
      const splWire = adapter.finalize(splMsg, splSigs[0]?.[payer.address] ?? new Uint8Array());
      const splHash = await adapter.broadcast(r, splWire);
      for (let i = 0; i < 30; i += 1) {
        const s = await adapter.status(r, splHash);
        if (s === "confirmed" || s === "finalized") {
          break;
        }
        await sleep(1000);
      }
      expect(["confirmed", "finalized"]).toContain(await adapter.status(r, splHash));
      const [destAta] = await findAssociatedTokenPda({
        mint: mint.address,
        owner: recipient.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ataBal = await r.call("getTokenAccountBalance", [destAta, { commitment: "confirmed" }]);
      expect(
        (ataBal as { value: { amount: string } }).value.amount,
      ).toBe("500000");
    } finally {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    }
  }, 180_000);
});
