import { describe, expect, it } from "vite-plus/test";

/**
 * The polymarket(wallet) facade: method names, param shapes and result unwrapping over a scripted
 * kernel, plus memoization and the foreign-wallet guard.
 */
import { verifyEvent } from "@qntx/nostr";

import type { SetTimer } from "../src/channel.ts";
import { polymarket } from "../src/polymarket/index.ts";
import type { PolymarketCredentialsInfo, PolymarketL2Headers } from "../src/protocol/index.ts";
import type { Wallet } from "../src/types.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, PASSKEY, ScriptedPort, unlockedStatus, walletError } from "./host.test.ts";

const realtime: SetTimer = (delayMs, fn) => {
  const timer = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

const OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const WALLET_ID = "0011223344556677";
const API_KEY = "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2";
const CREDS: PolymarketCredentialsInfo = {
  walletId: WALLET_ID,
  groupIndex: 0,
  owner: OWNER,
  apiKey: API_KEY,
  createdAt: 1_767_225_600_000,
};
const HEADERS: PolymarketL2Headers = {
  POLY_ADDRESS: OWNER,
  POLY_SIGNATURE: "2NZFuixCE1skWphuZCiWTtUTQ2wQ5WlM201Xnd5Vnxw=",
  POLY_TIMESTAMP: "1767225600",
  POLY_API_KEY: API_KEY,
  POLY_PASSPHRASE: "test-passphrase-1",
};

async function connect(): Promise<{
  wallet: Wallet;
  kernel: FakeKernel;
}> {
  const kernel = new FakeKernel({ ...unlockedStatus(), vault: "locked" });
  const wallet = await connectKernel({
    verifyEvent,
    spawn: () => {
      const port = new ScriptedPort(kernel);
      kernel.attach(port);
      return port;
    },
    factors: "software",
    passkey: PASSKEY,
    ceremony: undefined,
    setTimer: realtime,
  });
  await wallet.vault.unlock({ kind: "password", password: "long enough password" });
  return { wallet, kernel };
}

describe("polymarket(wallet)", () => {
  it("is memoized per wallet and rejects foreign objects", async () => {
    const { wallet } = await connect();
    expect(polymarket(wallet)).toBe(polymarket(wallet));
    expect(() => polymarket({} as Wallet)).toThrow("not a Wallet from @qntx/wallet");
  });

  it("importCredentials posts the method and resolves the owner", async () => {
    const { wallet, kernel } = await connect();
    let seen: unknown;
    kernel.handlers.set("polymarket.importCredentials", (request) => {
      seen = request.params;
      return { ok: { owner: OWNER } };
    });
    const params = {
      owner: { walletId: WALLET_ID, groupIndex: 0 },
      apiKey: API_KEY,
      secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
      passphrase: "test-passphrase-1",
    };
    await expect(polymarket(wallet).importCredentials(params)).resolves.toBe(OWNER);
    expect(seen).toStrictEqual(params);
    expect(kernel.received).toContain("polymarket.importCredentials");
  });

  it("listCredentials returns the header rows only", async () => {
    const { wallet, kernel } = await connect();
    kernel.handlers.set("polymarket.listCredentials", () => ({ ok: [CREDS] }));
    await expect(polymarket(wallet).listCredentials()).resolves.toStrictEqual([CREDS]);
    kernel.handlers.set("polymarket.listCredentials", () => ({
      ok: [{ ...CREDS, secret: "leak" }],
    }));
    await expect(polymarket(wallet).listCredentials()).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("deleteCredentials sends a flat {walletId, groupIndex}", async () => {
    const { wallet, kernel } = await connect();
    let seen: unknown;
    kernel.handlers.set("polymarket.deleteCredentials", (request) => {
      seen = request.params;
      return { ok: null };
    });
    await expect(
      polymarket(wallet).deleteCredentials({ walletId: WALLET_ID, groupIndex: 2 }),
    ).resolves.toBeUndefined();
    expect(seen).toStrictEqual({ walletId: WALLET_ID, groupIndex: 2 });
  });

  it("signL2 posts the request and unwraps the five headers", async () => {
    const { wallet, kernel } = await connect();
    let seen: unknown;
    kernel.handlers.set("polymarket.signL2", (request) => {
      seen = request.params;
      return { ok: { headers: HEADERS } };
    });
    const params = {
      owner: { walletId: WALLET_ID, groupIndex: 0 },
      method: "GET" as const,
      path: "/data/orders",
      timestamp: 1_767_225_600,
    };
    await expect(polymarket(wallet).signL2(params)).resolves.toStrictEqual(HEADERS);
    expect(seen).toStrictEqual(params);
  });

  it("rejects an off-schema signL2 result", async () => {
    const { wallet, kernel } = await connect();
    kernel.handlers.set("polymarket.signL2", () => ({
      ok: { headers: { ...HEADERS, POLY_SIGNATURE: "!!" } },
    }));
    await expect(
      polymarket(wallet).signL2({
        owner: { walletId: WALLET_ID, groupIndex: 0 },
        method: "GET",
        path: "/data/orders",
        timestamp: 1_767_225_600,
      }),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });
});
