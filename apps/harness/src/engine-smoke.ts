/**
 * Engine smoke (E-RN1): `createWalletEngine` on the RN main runtime (Hermes) over the real native
 * kernel with a hardware-factor wallet, the staging gateway and public host endpoints. Each step
 * prints one `smoke-engine-<step>` line through the V1 report channel with its duration; the first
 * failing step stops the run so the failure is the one to look at.
 */
import { randomBytes } from "react-native-quick-crypto";

import { report } from "@qntx/v1-probe";
import type { AutoLockPolicy } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import {
  createMemoryEngineStore,
  createMemoryPublicStore,
  createWalletEngine,
} from "@qntx/wallet-engine";
import type { WalletEngine } from "@qntx/wallet-engine";
import { createNativeWallet } from "@qntx/wallet-native";

import { PASSKEY } from "./passkey";
import { verifyEvent } from "./verify";

const AUTOLOCK: AutoLockPolicy = { platform: "native", backgroundSeconds: 0 };

const GATEWAY_URL = "https://wallet-gateway-staging.qntx.org";
const SEPOLIA = "eip155:11155111";
const SIGNET = "bip122:00000008819873e925422c1ff0f99f7c";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

// Generated with the engine test encoder: regtest, 21 sats, expires in 2046.
const LIGHTNING_INVOICE =
  "lnbcrt210000p1p45n5sqpp5qvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpssp5qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqdq8w3jhxaqxqxjespsqnp4q2vfczmkedtrju0aexl0x8kqds6kpueyn4hwnewc83tky4vkup0k74f670yztltcwjama7k0wlf9lz4x7v3llx2ttgkmfqnu7mxgly8wkwc3gs3kd9nteru44d3nc6v2nqjek5ukvcnl22qrnt5awhx38cgcquvh5h3";
const SPARK_ADDRESS = "sparkrt1pgssy44n9zesezl4sw0zgpv8g7regz9akd3yrhyu9e7xr8a2z2efyzt8trw58c";

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const step = async (name: string, run: () => Promise<string>): Promise<void> => {
  const started = Date.now();
  try {
    const detail = await run();
    report(`smoke-engine-${name}`, "release", true, JSON.stringify(`${detail} ms=${Date.now() - started}`));
  } catch (error) {
    report(
      `smoke-engine-${name}`,
      "release",
      false,
      JSON.stringify(`${errorText(error)} ms=${Date.now() - started}`),
    );
    throw error;
  }
};

const until = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
};

export async function engineSmoke(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const crypto = g["crypto"] as Record<string, unknown> | undefined;
  report(
    "smoke-engine-globals",
    "release",
    true,
    JSON.stringify(
      `crypto=${typeof crypto} getRandomValues=${typeof crypto?.["getRandomValues"]} subtle=${typeof crypto?.["subtle"]} Buffer=${typeof g["Buffer"]} TextEncoder=${typeof g["TextEncoder"]} URL=${typeof g["URL"]} AbortSignal.timeout=${typeof AbortSignal.timeout} structuredClone=${typeof g["structuredClone"]}`,
    ),
  );
  const wallet = await createNativeWallet({ verifyEvent, passkey: PASSKEY, autoLock: AUTOLOCK });
  let walletId = "";
  await step("wallet", async () => {
    const draft = await wallet.wallets.createMnemonic({ words: 12 });
    const words = new TextDecoder().decode(draft.words.read()).split(" ");
    ({ walletId } = await draft.confirm(draft.quiz.map((i) => words[i]!)));
    return `wallet=${walletId} factors=${wallet.getSnapshot().factors.map((f) => f.kind).join(",")}`;
  });

  const warnings: string[] = [];
  let engine!: WalletEngine;
  await step("create-engine", async () => {
    const installId = Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
    engine = createWalletEngine({
  verifyEvent,
      wallet,
      sparkNetwork: "regtest",
      fetch: globalThis.fetch,
      random: (n) => new Uint8Array(randomBytes(n)),
      now: () => Date.now(),
      weblnAlias: "qntx-smoke",
      lightningMaxFee: () => 0,
      logger: { warn: (message) => warnings.push(message) },
      publicStore: createMemoryPublicStore(),
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      showCallsStatus: () => undefined,
      rpc: {
        [SEPOLIA]: ["https://ethereum-sepolia-rpc.publicnode.com"],
        [SIGNET]: ["https://blockstream.info/signet/api"],
        [DEVNET]: ["https://solana-devnet.gateway.tatum.io"],
      },
      gateway: { url: GATEWAY_URL, installId },
    });
    return "ok";
  });

  await step("gateway-networks", async () => {
    const ready = await until(
      () => engine.networks.endpoints(SEPOLIA)[0]?.startsWith(GATEWAY_URL) === true,
      20_000,
    );
    if (!ready) {
      throw new Error(`gateway not in use; warnings=${warnings.join("|")}`);
    }
    return `sepolia=${engine.networks.endpoints(SEPOLIA)[0]} enabled=${engine.networks.enabled("evm").length}evm`;
  });

  const account = { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" } as const;
  let address = "";
  await step("evm-balance", async () => {
    const derived = await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "evm.bip44",
      network: SEPOLIA,
    });
    address = "address" in derived ? derived.address : "";
    const balance = await engine.networks.client(SEPOLIA).getBalance({ address: address as `0x${string}` });
    return `address=${address} balanceWei=${balance.toString()}`;
  });

  await step("prepare-reject", async () => {
    const request = await engine.requests.prepare({
      method: "send",
      account,
      network: SEPOLIA,
      to: address,
      amount: 0n,
      fee: "normal",
    });
    const summary = "summary" in request.display ? request.display.summary : "spark";
    engine.requests.reject(request.id);
    const stage = engine.requests.getState().requests[request.id]?.stage;
    if (stage !== "rejected") {
      throw new Error(`stage after reject: ${String(stage)}`);
    }
    return `summary=${summary} verification=${request.verification} checks=${request.checks.join(",") || "none"}`;
  });

  await step("gateway-reads", async () => {
    const fees: unknown = await engine.networks.esplora(SIGNET).get("/fee-estimates");
    const blockhash: unknown = await engine.networks
      .solanaRpc(DEVNET)
      .call("getLatestBlockhash", [{ commitment: "confirmed" }]);
    return `signet=${JSON.stringify(fees).slice(0, 60)} devnet=${JSON.stringify(blockhash).slice(0, 80)}`;
  });

  await step("payments-parse", async () => {
    const ln = engine.payments.parse(LIGHTNING_INVOICE, "regtest");
    const sp = engine.payments.parse(SPARK_ADDRESS, "regtest");
    const kinds = [ln, sp].map((p) =>
      p.kind === "request" ? p.request.options.map((o) => o.kind).join("+") : p.kind,
    );
    if (kinds[0] !== "lightning" || kinds[1] !== "spark") {
      throw new Error(`unexpected parse: ${kinds.join(",")}`);
    }
    return kinds.join(",");
  });

  await step("lock-invalidates", async () => {
    const request = await engine.requests.prepare({
      method: "send",
      account,
      network: SEPOLIA,
      to: address,
      amount: 0n,
      fee: "normal",
    });
    await wallet.vault.lock();
    const stopped = await until(
      () => engine.requests.getState().requests[request.id]?.stage === "invalidated",
      5000,
    );
    if (!stopped) {
      throw new Error(`stage: ${String(engine.requests.getState().requests[request.id]?.stage)}`);
    }
    return "invalidated";
  });
  engine.unsubscribe();
}
