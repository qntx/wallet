import { utf8ToBytes } from "@noble/hashes/utils.js";
/**
 * `hardware(wallet)` host proxy: the operation coroutine (begin → exchanges → step until done),
 * cancellation semantics and the shared sign-result verification, plus the pure QR helpers. The
 * kernel-side device logic is covered in packages/wallet-kernel/tests.
 */
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { signEvmPersonalMessage } from "@qntx/wallet-chains/evm/sign";

import { hardware, qrParts, qrReader } from "../src/hardware/index.ts";
import type { DeviceIo } from "../src/hardware/index.ts";
import type { DeviceResponse, HardwareResult } from "../src/protocol/hardware.ts";
import type { WalletInfo } from "../src/types.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, PASSKEY, ScriptedPort, unlockedStatus, walletError } from "./host.test.ts";

const OP_ID = "ab".repeat(16);
const WALLET: WalletInfo = {
  custody: "hardware",
  walletId: "0a".repeat(8),
  device: "keystone",
  fingerprint: "73c5da0a",
  model: "Keystone 3 Pro",
  supported: true,
  createdAt: 1735689600000,
};

const connect = async (kernel: FakeKernel) =>
  connectKernel({
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

const doneStep = (result: HardwareResult) => ({ kind: "done" as const, result });
const exchangeStep = {
  kind: "exchange",
  device: "keystone",
  request: {
    kind: "qr",
    show: { type: "crypto-multi-accounts", cbor: new Uint8Array([0xa0]) },
    scan: ["crypto-multi-accounts"],
  },
  display: "clear",
};

const responding = (io: Partial<DeviceIo>): DeviceIo => ({
  exchange:
    io.exchange ??
    (async () =>
      Promise.resolve({
        kind: "qr",
        ur: { type: "crypto-multi-accounts", cbor: new Uint8Array([0xa0]) },
      } as DeviceResponse)),
  ...(io.signal === undefined ? {} : { signal: io.signal }),
});

describe("hardware(wallet)", () => {
  it("runs begin → exchange → step until done and returns the result", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    let asks = 0;
    kernel.handlers.set("hardware.begin", () => {
      asks += 1;
      return { ok: { opId: OP_ID, step: exchangeStep } };
    });
    kernel.handlers.set("hardware.step", () => ({
      ok: doneStep({ kind: "pair", wallet: WALLET }),
    }));
    const wallet = await connect(kernel);
    const contexts: unknown[] = [];
    const info = await hardware(wallet).pair(
      "keystone",
      responding({
        exchange: async (request, context) => {
          contexts.push([request.kind, context]);
          return Promise.resolve({
            kind: "qr",
            ur: { type: "crypto-multi-accounts", cbor: new Uint8Array([0xa0]) },
          });
        },
      }),
    );
    expect(info).toStrictEqual(WALLET);
    expect(kernel.received).toStrictEqual(["hardware.begin", "hardware.step"]);
    expect(contexts).toStrictEqual([["qr", { device: "keystone", display: "clear" }]]);
    expect(asks).toBe(1);
  });

  it("refuses a done result whose kind is not the operation's", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("hardware.begin", () => ({
      ok: { opId: OP_ID, step: doneStep({ kind: "accounts", accounts: [] }) },
    }));
    const wallet = await connect(kernel);
    await expect(hardware(wallet).pair("keystone", responding({}))).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
    expect(kernel.received).toContain("hardware.cancel");
  });

  it("cancels the operation when the signal aborts mid-exchange", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("hardware.begin", () => ({ ok: { opId: OP_ID, step: exchangeStep } }));
    kernel.handlers.set("hardware.step", () => ({
      ok: doneStep({ kind: "pair", wallet: WALLET }),
    }));
    kernel.handlers.set("hardware.cancel", () => ({ ok: null }));
    const wallet = await connect(kernel);
    const controller = new AbortController();
    const io = responding({
      signal: controller.signal,
      exchange: async () => {
        controller.abort();
        return Promise.resolve({
          kind: "qr",
          ur: { type: "crypto-multi-accounts", cbor: new Uint8Array([0xa0]) },
        });
      },
    });
    await expect(hardware(wallet).pair("keystone", io)).rejects.toSatisfy(
      (e) => walletError(e).code === "cancelled",
    );
    expect(kernel.received).toContain("hardware.cancel");
    expect(kernel.received).not.toContain("hardware.step");
  });

  it("does not issue the next device request once the signal aborted during step", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("hardware.begin", () => ({ ok: { opId: OP_ID, step: exchangeStep } }));
    const controller = new AbortController();
    kernel.handlers.set("hardware.step", () => {
      controller.abort();
      return { ok: exchangeStep };
    });
    kernel.handlers.set("hardware.cancel", () => ({ ok: null }));
    const wallet = await connect(kernel);
    let exchanges = 0;
    const io = responding({
      signal: controller.signal,
      exchange: async () => {
        exchanges += 1;
        return Promise.resolve({
          kind: "qr",
          ur: { type: "crypto-multi-accounts", cbor: new Uint8Array([0xa0]) },
        });
      },
    });
    await expect(hardware(wallet).pair("keystone", io)).rejects.toSatisfy(
      (e) => walletError(e).code === "cancelled",
    );
    expect(exchanges).toBe(1);
    expect(kernel.received).toContain("hardware.cancel");
  });

  it("cancels the operation and rethrows when the transport rejects", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("hardware.begin", () => ({ ok: { opId: OP_ID, step: exchangeStep } }));
    kernel.handlers.set("hardware.cancel", () => ({ ok: null }));
    const wallet = await connect(kernel);
    const failure = new Error("camera denied");
    const io = responding({
      exchange: async () => Promise.reject(failure),
    });
    await expect(hardware(wallet).pair("keystone", io)).rejects.toBe(failure);
    expect(kernel.received).toContain("hardware.cancel");
  });

  const PRIV = new Uint8Array(32).fill(7);
  const ADDRESS = "0x4a62316623ad457F02cDC5D997deD67a383EC569";
  const MESSAGE = utf8ToBytes("hello");
  const signRequest = {
    kind: "evm.personal-message" as const,
    network: "eip155:1",
    account: {
      kind: "hd" as const,
      walletId: WALLET.walletId,
      groupIndex: 0,
      template: "evm.bip44" as const,
    },
    message: MESSAGE,
  };

  const signKernel = (signature: Uint8Array) => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("hardware.begin", () => ({
      ok: {
        opId: OP_ID,
        step: doneStep({ kind: "sign", result: { kind: "evm.personal-message", signature } }),
      },
    }));
    kernel.handlers.set("wallet.accounts", () => ({
      ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS },
    }));
    return kernel;
  };

  it("verifies a device signature the same way chains().sign does", async () => {
    const kernel = signKernel(signEvmPersonalMessage(MESSAGE, PRIV));
    const wallet = await connect(kernel);
    const result = await hardware(wallet).sign(
      { request: signRequest, verify: { kind: "password", password: "test password" } },
      responding({}),
    );
    expect(result.kind).toBe("evm.personal-message");
    expect(kernel.received).toContain("hardware.begin");
    expect(kernel.received).toContain("wallet.accounts");
  });

  it("rejects a forged device signature with integrity", async () => {
    const kernel = signKernel(signEvmPersonalMessage(MESSAGE, new Uint8Array(32).fill(8)));
    kernel.handlers.set("hardware.cancel", () => ({ ok: null }));
    const wallet = await connect(kernel);
    await expect(
      hardware(wallet).sign(
        { request: signRequest, verify: { kind: "password", password: "test password" } },
        responding({}),
      ),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });

  it("marks verifying only while begin runs, not while the device exchange waits", async () => {
    const signature = signEvmPersonalMessage(MESSAGE, PRIV);
    const kernel = new FakeKernel(unlockedStatus());
    const duringBegin: boolean[] = [];
    const duringExchange: boolean[] = [];
    const wallet = await connect(kernel);
    kernel.handlers.set("hardware.begin", () => {
      duringBegin.push(wallet.getSnapshot().verifying);
      return { ok: { opId: OP_ID, step: exchangeStep } };
    });
    kernel.handlers.set("hardware.step", () => ({
      ok: doneStep({ kind: "sign", result: { kind: "evm.personal-message", signature } }),
    }));
    kernel.handlers.set("wallet.accounts", () => ({
      ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS },
    }));
    await hardware(wallet).sign(
      { request: signRequest, verify: { kind: "password", password: "test password" } },
      responding({
        exchange: async () => {
          duringExchange.push(wallet.getSnapshot().verifying);
          return Promise.resolve({
            kind: "qr",
            ur: { type: "crypto-multi-accounts", cbor: new Uint8Array([0xa0]) },
          } as DeviceResponse);
        },
      }),
    );
    expect(duringBegin).toStrictEqual([true]);
    expect(duringExchange).toStrictEqual([false]);
  });
});

describe("qrParts / qrReader", () => {
  const payload = { type: "crypto-psbt", cbor: new Uint8Array(1200).fill(9) };

  it("round-trips a multi-part payload through shuffled, duplicated frames", () => {
    const next = qrParts(payload, { maxFragmentLength: 80 });
    const emitted = Array.from({ length: 24 }, () => next());
    expect(emitted.every((part) => part.startsWith("UR:CRYPTO-PSBT/"))).toBe(true);

    const reader = qrReader(["crypto-psbt"]);
    let progress = 0;
    let decoded;
    // Deterministic interleave with duplicates; a foreign-type frame must be ignored.
    const foreign = qrParts({ type: "bytes", cbor: new Uint8Array(16) })();
    const frames = [
      ...emitted.slice(14, 24),
      ...emitted.slice(3, 4),
      foreign,
      ...emitted.slice(0, 14),
    ];
    let previous = 0;
    for (const frame of frames) {
      const { progress: ratio, payload } = reader.receive(frame);
      expect(ratio).toBeGreaterThanOrEqual(previous);
      previous = ratio;
      progress = ratio;
      decoded = payload;
    }
    expect(progress).toBe(1);
    expect(decoded?.type).toBe("crypto-psbt");
    expect(decoded?.cbor).toStrictEqual(payload.cbor);
  });

  it("keeps progress unchanged on a foreign-type frame", () => {
    const next = qrParts(payload, { maxFragmentLength: 80 });
    const reader = qrReader(["crypto-psbt"]);
    reader.receive(next());
    const before = reader.receive(next()).progress;
    const foreignPart = qrParts({ type: "bytes", cbor: new Uint8Array(64) })();
    const result = reader.receive(foreignPart);
    expect(result.progress).toBe(before);
    expect(result.payload).toBeUndefined();
  });

  it("decodes a single-part payload in one frame", () => {
    const small = { type: "bytes", cbor: new Uint8Array([1, 2, 3]) };
    const part = qrParts(small)();
    const result = qrReader(["bytes"]).receive(part);
    expect(result.progress).toBe(1);
    expect(result.payload).toStrictEqual(small);
  });
});
