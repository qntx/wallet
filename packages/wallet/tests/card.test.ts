import { utf8ToBytes } from "@noble/hashes/utils.js";
/**
 * `card(wallet)` host proxy: `start` runs `card.begin` and polls `card.step` until `done`, the host
 * renders each step (`input` → SecureInput, `tap` → hold the card) and `result` resolves the
 * operation's outcome — or its WalletError. A `sign` result is verified against the request and
 * account like `chains(wallet).sign`, so a kernel that answers with a forged signature fails closed
 * with `integrity`. APDUs never cross this channel.
 */
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { signEvmPersonalMessage } from "@qntx/wallet-chains/evm/sign";

import { card } from "../src/card/index.ts";
import type { CardStep } from "../src/protocol/index.ts";
import type { Wallet } from "../src/types.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, PASSKEY, ScriptedPort, unlockedStatus, walletError } from "./host.test.ts";

const OP_ID = "ab".repeat(16);
const STATUS_DONE: CardStep = {
  kind: "done",
  result: { kind: "status", life: "loaded", tries: 10 },
};

type ConnectResult = {
  kernel: FakeKernel;
  wallet: Wallet;
};

/** A wallet on the scripted kernel; card.* methods are per-test handlers on `kernel`. */
const connect = async (
  handlers: Record<string, (request: { params?: unknown }) => unknown>,
): Promise<ConnectResult> => {
  const kernel = new FakeKernel(unlockedStatus());
  for (const [method, handler] of Object.entries(handlers)) {
    kernel.handlers.set(method, (request) => handler(request) as never);
  }
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
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  });
  await wallet.vault.unlock({ kind: "password", password: "long enough password" });
  return { kernel, wallet };
};

describe("card(wallet)", () => {
  it("emits every step the kernel reports and resolves the done result", async () => {
    const steps: CardStep[] = [
      { kind: "input", purpose: "access-code", card: "0A1B-2C3D" },
      { kind: "tap", reason: "member", card: "0A1B-2C3D", hold: true },
      STATUS_DONE,
    ];
    let index = 1;
    const { kernel, wallet } = await connect({
      "card.begin": () => ({ ok: { opId: OP_ID, step: steps[0] } }),
      "card.step": () => {
        const step = steps[Math.min(index, steps.length - 1)];
        index += 1;
        return { ok: step };
      },
    });

    const task = card(wallet).start({ kind: "status" });
    const seen: CardStep[] = [];
    task.observe((step) => seen.push(step));
    await expect(task.result).resolves.toStrictEqual(STATUS_DONE.result);
    expect(seen).toStrictEqual(steps);
    expect(kernel.received.filter((m) => m === "card.step")).toHaveLength(2);
  });

  it("replays the current step to a late observer and unsubscribes", async () => {
    const { wallet } = await connect({
      "card.begin": () => ({ ok: { opId: OP_ID, step: { kind: "tap", reason: "any" } } }),
      "card.step": async () => new Promise(() => undefined), // the tap is still in flight
      "card.cancel": () => ({ ok: null }),
    });
    const task = card(wallet).start({ kind: "status" });
    const first: CardStep[] = [];
    const second: CardStep[] = [];
    let tapSeen!: () => void;
    const tap = new Promise<void>((resolve) => {
      tapSeen = resolve;
    });
    task.observe((step) => {
      first.push(step);
      tapSeen();
    });
    await tap;
    task.observe((step) => second.push(step));
    expect(first).toStrictEqual([{ kind: "tap", reason: "any" }]);
    expect(second).toStrictEqual([{ kind: "tap", reason: "any" }]);
    const off = task.observe(() => first.push(STATUS_DONE));
    off();
    await task.cancel();
  });

  it("sends the resolved verify factor on card.begin", async () => {
    let seen: unknown;
    const { wallet } = await connect({
      "card.begin": (request) => {
        seen = (request.params as { verify?: unknown }).verify;
        return { ok: { opId: OP_ID, step: STATUS_DONE } };
      },
    });
    const task = card(wallet).start(
      { kind: "health", walletId: "0a".repeat(8) },
      { verify: { kind: "password", password: "test password" } },
    );
    await task.result;
    expect(seen).toBeDefined();
  });

  it("cancel after begin fires card.cancel and the result rejects cancelled", async () => {
    const { kernel, wallet } = await connect({
      "card.begin": () => ({ ok: { opId: OP_ID, step: { kind: "tap", reason: "any" } } }),
      "card.step": async () => new Promise(() => undefined),
      "card.cancel": () => ({ ok: null }),
    });
    const task = card(wallet).start({ kind: "status" });
    await task.cancel();
    await expect(task.result).rejects.toSatisfy((e) => walletError(e).code === "cancelled");
    expect(kernel.received).toContain("card.cancel");
  });

  it("cancel before begin answered remembers and cancels with the landed opId", async () => {
    let resolveBegin!: (value: unknown) => void;
    let beginSeen!: () => void;
    const seen = new Promise<void>((resolve) => {
      beginSeen = resolve;
    });
    const { kernel, wallet } = await connect({
      "card.begin": async () => {
        beginSeen();
        return new Promise((resolve) => {
          resolveBegin = resolve;
        });
      },
      "card.cancel": () => ({ ok: null }),
    });
    const task = card(wallet).start({ kind: "status" });
    const cancelled = task.cancel();
    await seen;
    expect(kernel.received).not.toContain("card.cancel");
    resolveBegin({ ok: { opId: OP_ID, step: { kind: "tap", reason: "any" } } });
    await cancelled;
    expect(kernel.received).toContain("card.cancel");
    await expect(task.result).rejects.toSatisfy((e) => walletError(e).code === "cancelled");
  });

  it("a second start cancels the first operation", async () => {
    const cancelled: string[] = [];
    const { kernel, wallet } = await connect({
      "card.begin": () => ({ ok: { opId: OP_ID, step: { kind: "tap", reason: "any" } } }),
      "card.step": async () => new Promise(() => undefined),
      "card.cancel": () => {
        cancelled.push("x");
        return { ok: null };
      },
    });
    const first = card(wallet).start({ kind: "status" });
    await Promise.resolve();
    const second = card(wallet).start({ kind: "health", walletId: "0a".repeat(8) });
    await expect(first.result).rejects.toSatisfy((e) => walletError(e).code === "cancelled");
    expect(cancelled).toHaveLength(1);
    await second.cancel();
    expect(kernel.received.filter((m) => m === "card.cancel")).toHaveLength(2);
  });

  it("memoizes the api per wallet and refuses a foreign wallet", async () => {
    const { wallet } = await connect({});
    expect(card(wallet)).toBe(card(wallet));
    expect(() => card({} as Wallet)).toThrow(
      expect.objectContaining({ code: "invalid-input" }) as Error,
    );
  });

  it("a sign result on a non-sign operation is integrity", async () => {
    const { wallet } = await connect({
      "card.begin": () => ({
        ok: {
          opId: OP_ID,
          step: {
            kind: "done",
            result: {
              kind: "sign",
              result: { kind: "evm.personal-message", signature: new Uint8Array(65) },
            },
          },
        },
      }),
    });
    const task = card(wallet).start({ kind: "status" });
    await expect(task.result).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });

  describe("sign results", () => {
    const PRIV = new Uint8Array(32).fill(7);
    const ADDRESS = "0x4a62316623ad457F02cDC5D997deD67a383EC569";
    const MESSAGE = utf8ToBytes("hello");
    const REQUEST = {
      kind: "evm.personal-message" as const,
      network: "eip155:1",
      account: {
        kind: "hd" as const,
        walletId: "0a".repeat(8),
        groupIndex: 0,
        template: "evm.bip44" as const,
      },
      message: MESSAGE,
    };

    const signConnect = async (signature: Uint8Array) =>
      connect({
        "card.begin": () => ({
          ok: {
            opId: OP_ID,
            step: {
              kind: "done",
              result: { kind: "sign", result: { kind: "evm.personal-message", signature } },
            },
          },
        }),
        "wallet.accounts": () => ({
          ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS },
        }),
      });

    it("resolves a card signature that verifies for the account", async () => {
      const { kernel, wallet } = await signConnect(signEvmPersonalMessage(MESSAGE, PRIV));
      const task = card(wallet).start({ kind: "sign", request: REQUEST });
      await expect(task.result).resolves.toStrictEqual({
        kind: "sign",
        result: { kind: "evm.personal-message", signature: signEvmPersonalMessage(MESSAGE, PRIV) },
      });
      expect(kernel.received).toContain("wallet.accounts");
    });

    it("rejects a forged card signature with integrity, never emitting done", async () => {
      const { wallet } = await signConnect(
        signEvmPersonalMessage(MESSAGE, new Uint8Array(32).fill(8)),
      );
      const task = card(wallet).start({ kind: "sign", request: REQUEST });
      const seen: CardStep[] = [];
      task.observe((step) => seen.push(step));
      await expect(task.result).rejects.toSatisfy((e) => walletError(e).code === "integrity");
      expect(seen.some((step) => step.kind === "done")).toBe(false);
    });
  });
});
