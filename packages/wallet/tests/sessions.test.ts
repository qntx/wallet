import { secp256k1 } from "@noble/curves/secp256k1.js";
/**
 * `sessions(wallet).sign` verifies what the kernel answered: the facade rebuilds the scheme's
 * document for the record's scope, recovers the signer, and refuses `integrity` on a signature that
 * is not the session key's over exactly that document — or on a record that does not match the
 * request.
 */
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { evmAddressFromPublicKey, hyperliquidL1Document } from "@qntx/wallet-chains/evm";
import { signEvmTypedData } from "@qntx/wallet-chains/evm/sign";

import type { HyperliquidL1Params, SessionInfo } from "../src/protocol/index.ts";
import { sessions } from "../src/sessions/index.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, unlockedStatus, PASSKEY, ScriptedPort, walletError } from "./host.test.ts";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

const SESSION_KEY = new Uint8Array(32).fill(11);
const OTHER_KEY = new Uint8Array(32).fill(23);
const SESSION_ADDRESS = evmAddressFromPublicKey(secp256k1.getPublicKey(SESSION_KEY, true));

const PARAMS: HyperliquidL1Params = {
  action: { type: "cancel", cancels: [{ a: 0, o: 1 }] },
  nonce: T0,
  expiresAfter: T0 + 15_000,
};

const record = (scope: string, scheme = "hyperliquid-l1-agent"): SessionInfo => ({
  address: SESSION_ADDRESS,
  scheme,
  supported: true,
  walletId: "0a".repeat(8),
  groupIndex: 0,
  owner: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  scope,
  name: "bot",
  validUntil: T0 + 180 * DAY,
  createdAt: T0,
  limits: {
    notional: "10000",
    maxLeverage: 25,
    assets: [
      { asset: 0, size: "10000" },
      { asset: 1, size: "10000" },
      { asset: 2, size: "10000" },
      { asset: 3, size: "10000" },
    ],
  },
  spent: { notional: "0", size: ["0", "0", "0", "0"] },
});

const connect = async (signature: Uint8Array, records: ReadonlyArray<SessionInfo>) => {
  const kernel = new FakeKernel(unlockedStatus());
  kernel.handlers.set("sessions.sign", () => ({ ok: { signature } }));
  kernel.handlers.set("sessions.list", () => ({ ok: records }));
  return connectKernel({
    verifyEvent,
    spawn: () => {
      const port = new ScriptedPort(kernel);
      kernel.attach(port);
      return port;
    },
    factors: "software",
    passkey: PASSKEY,
    ceremony: undefined,
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  });
};

const request = {
  scheme: "hyperliquid-l1-agent" as const,
  address: SESSION_ADDRESS,
  params: PARAMS,
};

describe("sessions(wallet).sign verification", () => {
  it("returns the session key's signature over the scheme's document", async () => {
    const signature = signEvmTypedData(hyperliquidL1Document(PARAMS, "Mainnet"), SESSION_KEY);
    const wallet = await connect(signature, [record("Mainnet")]);
    const result = await sessions(wallet).sign(request);
    expect(result).toStrictEqual(signature);
  });

  it("rejects a signature made by another key with integrity", async () => {
    const signature = signEvmTypedData(hyperliquidL1Document(PARAMS, "Mainnet"), OTHER_KEY);
    const wallet = await connect(signature, [record("Mainnet")]);
    await expect(sessions(wallet).sign(request)).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("rejects the session key's signature over different params with integrity", async () => {
    const signature = signEvmTypedData(
      hyperliquidL1Document({ ...PARAMS, nonce: PARAMS.nonce + 1 }, "Mainnet"),
      SESSION_KEY,
    );
    const wallet = await connect(signature, [record("Mainnet")]);
    await expect(sessions(wallet).sign(request)).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("rejects a signature under a scope the record does not carry with integrity", async () => {
    const signature = signEvmTypedData(hyperliquidL1Document(PARAMS, "Mainnet"), SESSION_KEY);
    const wallet = await connect(signature, [record("Testnet")]);
    await expect(sessions(wallet).sign(request)).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("rejects a signature when no session record matches the address with integrity", async () => {
    const signature = signEvmTypedData(hyperliquidL1Document(PARAMS, "Mainnet"), SESSION_KEY);
    const wallet = await connect(signature, []);
    await expect(sessions(wallet).sign(request)).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("rejects a signature when the record's scheme is not the request's with integrity", async () => {
    const signature = signEvmTypedData(hyperliquidL1Document(PARAMS, "Mainnet"), SESSION_KEY);
    const wallet = await connect(signature, [record("Mainnet", "unknown-scheme")]);
    await expect(sessions(wallet).sign(request)).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  /* A scope the scheme does not admit cannot yield a document — even a signature that would
     verify under a neighbouring scope is refused by the scope guard itself, before recovery. */
  it("rejects a record whose scope the scheme does not admit with integrity", async () => {
    const signature = signEvmTypedData(hyperliquidL1Document(PARAMS, "Testnet"), SESSION_KEY);
    const wallet = await connect(signature, [record("Devnet")]);
    const failure = sessions(wallet).sign(request);
    await expect(failure).rejects.toSatisfy((e) => walletError(e).code === "integrity");
    await expect(failure).rejects.toThrow("sessions.sign answered for a scope the scheme rejects");
  });

  it("rejects a signature that fails recovery with integrity", async () => {
    const wallet = await connect(new Uint8Array(65), [record("Mainnet")]);
    await expect(sessions(wallet).sign(request)).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });
});
