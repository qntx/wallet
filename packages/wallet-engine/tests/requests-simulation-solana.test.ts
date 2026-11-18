import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { createMessage } from "@qntx/siwx";
import { siws } from "@qntx/siwx/svm";

import { AddressBookController } from "../src/addresses/controller.ts";
import {
  BlindSigningDisabledError,
  RequestController,
  SignInOriginError,
} from "../src/requests/controller.ts";
import type { SimulationOutcome } from "../src/requests/simulation.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import { tokensStub } from "./send-helpers.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ACCOUNT = { walletId: "w", groupIndex: 0, address: "11111111111111111111111111111112" };
const ORIGIN = { kind: "browser", origin: "https://app.example" } as const;

function rig(
  simulate: (message: Uint8Array) => Promise<SimulationOutcome>,
  blindSigning: () => boolean = () => false,
) {
  const calls: Uint8Array[] = [];
  const openStore = async () => Promise.resolve(createMemoryEngineStore());
  const logger = { warn: () => undefined };
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning,
    tokens: tokensStub,
    simulateSolana: async (_account, _network, message) => {
      calls.push(message);
      return simulate(message);
    },
    transactions: {} as unknown as TransactionController,
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    addressBook: new AddressBookController({
      openStore,
      random: (n) => new Uint8Array(n),
      now: () => 0,
      logger,
    }),
    openStore,
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  return { requests, calls };
}

/** A serialized legacy transaction signed for ACCOUNT: one empty slot, then the message. */
const solanaTx = (): { tx: Uint8Array; message: Uint8Array } => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, 1_000_000n, true);
  const message = new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(
        appendTransactionMessageInstruction(
          {
            programAddress: address("11111111111111111111111111111111"),
            accounts: [
              { address: address(ACCOUNT.address), role: AccountRole.WRITABLE_SIGNER },
              {
                address: address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"),
                role: AccountRole.WRITABLE,
              },
            ],
            data,
          },
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: address("11111111111111111111111111111111"),
              lastValidBlockHeight: 1000n,
            } as never,
            setTransactionMessageFeePayer(
              address(ACCOUNT.address),
              createTransactionMessage({ version: "legacy" }),
            ),
          ),
        ),
      ),
    ),
  );
  return { tx: new Uint8Array([1, ...new Uint8Array(64), ...message]), message };
};

const sign = (transactions: Uint8Array[], send = false) => ({
  method: "solana-sign" as const,
  origin: ORIGIN,
  account: ACCOUNT,
  network: NETWORK,
  request: { kind: "transactions" as const, transactions, send },
});

describe("solana-sign simulation", () => {
  it("simulates a single transaction and attaches the outcome", async () => {
    const outcome: SimulationOutcome = {
      status: "success",
      changes: [{ asset: "lamports", amount: "-5000", verified: true }],
    };
    const { requests, calls } = rig(async () => Promise.resolve(outcome));
    await requests.init();
    const { tx, message } = solanaTx();
    const request = await requests.prepare(sign([tx]));
    expect(calls).toStrictEqual([message]);
    expect(request.simulation).toStrictEqual(outcome);
    expect(request.checks).toStrictEqual([]);
  });

  it("does not simulate a batch: unavailable with error batch", async () => {
    const { requests, calls } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    const request = await requests.prepare(sign([solanaTx().tx, solanaTx().tx]));
    expect(calls).toHaveLength(0);
    expect(request.simulation).toStrictEqual({ status: "unavailable", error: "batch" });
    expect(request.checks).toStrictEqual(["simulation-unavailable"]);
    expect(request.verification).toBe("unverifiable");
  });

  it("turns a thrown simulation into unavailable", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("rpc down")));
    await requests.init();
    const request = await requests.prepare(sign([solanaTx().tx]));
    expect(request.simulation).toStrictEqual({ status: "unavailable", error: "rpc down" });
  });

  it("flags a revert as a danger", async () => {
    const { requests } = rig(async () =>
      Promise.resolve({ status: "reverted" as const, error: "boom" }),
    );
    await requests.init();
    const request = await requests.prepare(sign([solanaTx().tx]));
    expect(request.risk).toContainEqual({ code: "simulation-reverted", level: "danger" });
  });

  it("rejects an undecodable transaction at prepare", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    await expect(requests.prepare(sign([new Uint8Array([1])]))).rejects.toThrow(/failed to decode/);
  });

  it("does not simulate a message signature", async () => {
    const { requests, calls } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    const request = await requests.prepare({
      method: "solana-sign",
      origin: ORIGIN,
      account: ACCOUNT,
      network: NETWORK,
      request: { kind: "message", message: new Uint8Array([1]) },
    });
    expect(calls).toHaveLength(0);
    expect(request.simulation).toBeUndefined();
  });

  it("shows a message request's text and a sign-in's fields", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    const plain = await requests.prepare({
      method: "solana-sign",
      origin: ORIGIN,
      account: ACCOUNT,
      network: NETWORK,
      request: { kind: "message", message: new TextEncoder().encode("hello") },
    });
    expect(plain.display).toMatchObject({ kind: "solana.sign", message: { text: "hello" } });
    expect(plain.display).not.toHaveProperty("signIn");
  });

  it("carries the sign-in fields in the display", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    const signIn = { domain: "app.example", address: ACCOUNT.address, nonce: "n" };
    const request = await requests.prepare({
      method: "solana-sign",
      origin: ORIGIN,
      account: ACCOUNT,
      network: NETWORK,
      request: { kind: "message", message: new TextEncoder().encode("text"), signIn },
    });
    expect(request.display).toMatchObject({ message: { text: "text" }, signIn });
  });

  it("rejects non-UTF-8 message bytes unless the vault allows blind signing", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    await expect(
      requests.prepare({
        method: "solana-sign",
        origin: ORIGIN,
        account: ACCOUNT,
        network: NETWORK,
        request: { kind: "message", message: new Uint8Array([0xff]) },
      }),
    ).rejects.toBeInstanceOf(BlindSigningDisabledError);

    const enabled = rig(
      async () => Promise.reject(new Error("never")),
      () => true,
    );
    await enabled.requests.init();
    const request = await enabled.requests.prepare({
      method: "solana-sign",
      origin: ORIGIN,
      account: ACCOUNT,
      network: NETWORK,
      request: { kind: "message", message: new Uint8Array([0xff]) },
    });
    expect(request.display).toMatchObject({
      kind: "solana.sign",
      message: { kind: "bytes", hex: "0xff" },
    });
    expect(request.risk).toStrictEqual([{ code: "blind-signing", level: "danger" }]);
  });
});

describe("solana-sign Sign-In with Solana messages", () => {
  const SIGNER = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
  const siwsText = (domain: string): string =>
    siws.format(
      createMessage({
        domain,
        address: SIGNER,
        uri: `https://${domain}/login`,
        version: "1",
        chainId: "mainnet",
        nonce: "12341234",
        issuedAt: "2022-03-17T12:45:13.610Z",
      }),
    );
  const message = (text: string) => ({
    method: "solana-sign" as const,
    origin: ORIGIN,
    account: { ...ACCOUNT, address: SIGNER },
    network: NETWORK,
    request: { kind: "message" as const, message: new TextEncoder().encode(text) },
  });

  it("refuses a message for another domain", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    await expect(requests.prepare(message(siwsText("evil.example")))).rejects.toBeInstanceOf(
      SignInOriginError,
    );
  });

  it("shows the parsed sign-in for the page's own domain", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    const request = await requests.prepare(message(siwsText("app.example")));
    expect(request.display).toMatchObject({
      kind: "solana.sign",
      message: { signIn: { status: "valid" } },
    });
    expect(request.risk).toStrictEqual([]);
  });

  it("warns about text that only resembles a sign-in message", async () => {
    const { requests } = rig(async () => Promise.reject(new Error("never")));
    await requests.init();
    const request = await requests.prepare(message(`${siwsText("app.example")}\nextra`));
    expect(request.risk).toStrictEqual([{ code: "sign-in-malformed", level: "warning" }]);
  });
});
