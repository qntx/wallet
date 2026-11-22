/**
 * The kernel-side bindings for `__qntx.cardReader` and `__qntx.secureInput`: every native outcome
 * maps to the kernel result, an unknown or missing code degrades to `unavailable`, a response
 * outside the APDU answer limits is refused, and secure-input bytes that break the kind's rules are
 * wiped before the promise resolves.
 */
import { describe, expect, it } from "vite-plus/test";

import { bindNativeCardReader, bindNativeSecureInput } from "../kernel/card.ts";
import type { KernelCardReaderNative, KernelSecureInputNative } from "../kernel/card.ts";

type OpenReply = { code?: string | undefined; detail?: string | undefined };
type TransmitReply = {
  response?: Uint8Array | undefined;
  code?: string | undefined;
  detail?: string | undefined;
};

/** A native reader stand-in that replays the given outcomes and records every call. */
function nativeReader(replies: { open?: OpenReply; transmit?: TransmitReply }) {
  const calls: { prompt?: string; apdu?: Uint8Array; close?: { outcome: string; text: string } } =
    {};
  const raw: KernelCardReaderNative = {
    open: (prompt, done) => {
      calls.prompt = prompt;
      setTimeout(() => {
        done(replies.open?.code, replies.open?.detail);
      });
    },
    transmit: (apdu, done) => {
      calls.apdu = apdu;
      setTimeout(() => {
        done(replies.transmit?.response, replies.transmit?.code, replies.transmit?.detail);
      });
    },
    close: (outcome, text) => {
      calls.close = { outcome, text };
    },
  };
  return { raw, calls };
}

type RequestReply = { value?: Uint8Array | undefined; code?: string | undefined };

/** A native secure-input stand-in that captures the request and answers with `reply`. */
function nativeInput(reply: RequestReply) {
  const seen: { kind?: string; label?: string; cancels: number } = { cancels: 0 };
  const raw: KernelSecureInputNative = {
    request: (kind, label, done) => {
      seen.kind = kind;
      seen.label = label;
      setTimeout(() => {
        done(reply.value, reply.code);
      });
    },
    cancel: () => {
      seen.cancels += 1;
    },
  };
  return { raw, seen };
}

describe("bindNativeCardReader", () => {
  it("connects a session on a successful open", async () => {
    const { raw, calls } = nativeReader({ open: {} });
    const result = await bindNativeCardReader(raw).open("读卡中…");
    expect(result).toStrictEqual({ ok: true, value: undefined });
    expect(calls.prompt).toBe("读卡中…");
  });

  it.each([
    ["cancelled", "NFCError:200"],
    ["timeout", "NFCError:202"],
    ["tag-lost", undefined],
    ["interrupted", "android:paused"],
    ["unavailable", undefined],
  ] as const)("open failure %s surfaces with its detail", async (code, detail) => {
    const { raw } = nativeReader({ open: { code, detail } });
    const result = await bindNativeCardReader(raw).open("p");
    expect(result).toStrictEqual({ ok: false, failure: code, detail });
  });

  it("maps an unknown open code to unavailable", async () => {
    const { raw } = nativeReader({ open: { code: "exploded", detail: "x:1" } });
    const result = await bindNativeCardReader(raw).open("p");
    expect(result).toStrictEqual({ ok: false, failure: "unavailable", detail: "x:1" });
  });

  it("passes the APDU through and returns the response bytes", async () => {
    const { raw, calls } = nativeReader({
      transmit: { response: new Uint8Array([1, 2, 0x90, 0x00]) },
    });
    const apdu = new Uint8Array([0, 0xa4, 4, 0, 9]);
    const result = await bindNativeCardReader(raw).transmit(apdu);
    expect(result).toStrictEqual({ ok: true, value: new Uint8Array([1, 2, 0x90, 0x00]) });
    expect(calls.apdu).toBe(apdu);
  });

  it("accepts a bare status-word answer at the minimum length", async () => {
    const { raw } = nativeReader({ transmit: { response: new Uint8Array([0x6a, 0x82]) } });
    const result = await bindNativeCardReader(raw).transmit(new Uint8Array(4));
    expect(result).toStrictEqual({ ok: true, value: new Uint8Array([0x6a, 0x82]) });
  });

  it.each([1, 259] as const)("refuses a %d-byte response as unavailable", async (length) => {
    const { raw } = nativeReader({ transmit: { response: new Uint8Array(length) } });
    const result = await bindNativeCardReader(raw).transmit(new Uint8Array(4));
    expect(result).toStrictEqual({ ok: false, failure: "unavailable", detail: undefined });
  });

  it("refuses a non-Uint8Array response as unavailable", async () => {
    const { raw } = nativeReader({
      transmit: { response: [0x90, 0x00] as unknown as Uint8Array },
    });
    const result = await bindNativeCardReader(raw).transmit(new Uint8Array(4));
    expect(result).toStrictEqual({ ok: false, failure: "unavailable", detail: undefined });
  });

  it("surfaces a transmit failure with its detail", async () => {
    const { raw } = nativeReader({ transmit: { code: "tag-lost", detail: "nfc:lost" } });
    const result = await bindNativeCardReader(raw).transmit(new Uint8Array(4));
    expect(result).toStrictEqual({ ok: false, failure: "tag-lost", detail: "nfc:lost" });
  });

  it("maps a missing outcome to unavailable", async () => {
    const { raw } = nativeReader({ transmit: {} });
    const result = await bindNativeCardReader(raw).transmit(new Uint8Array(4));
    expect(result).toStrictEqual({ ok: false, failure: "unavailable", detail: undefined });
  });

  it("drops an out-of-shape detail", async () => {
    const { raw } = nativeReader({ transmit: { code: "timeout", detail: "not a token!" } });
    const result = await bindNativeCardReader(raw).transmit(new Uint8Array(4));
    expect(result).toStrictEqual({ ok: false, failure: "timeout", detail: undefined });
  });

  it("forwards the close outcome and text verbatim", () => {
    const { raw, calls } = nativeReader({});
    bindNativeCardReader(raw).close("failure", "");
    expect(calls.close).toStrictEqual({ outcome: "failure", text: "" });
  });
});

describe("bindNativeSecureInput", () => {
  it("returns the bytes a valid access-code submission carried", async () => {
    const { raw, seen } = nativeInput({ value: new TextEncoder().encode("S3cr3t!") });
    const result = await bindNativeSecureInput(raw).request("access-code", "输入访问码");
    expect(result).toStrictEqual({ ok: true, value: new TextEncoder().encode("S3cr3t!") });
    expect(seen).toMatchObject({ kind: "access-code", label: "输入访问码" });
  });

  it("accepts a full-length 64-byte access code", async () => {
    const { raw } = nativeInput({ value: new Uint8Array(64).fill(0x7e) });
    const result = await bindNativeSecureInput(raw).request("access-code", "l");
    expect(result.ok).toBe(true);
  });

  it.each([0, 65] as const)("wipes and refuses a %d-byte access code", async (length) => {
    const value = new Uint8Array(length).fill(0x41);
    const { raw } = nativeInput({ value });
    const result = await bindNativeSecureInput(raw).request("access-code", "l");
    expect(result).toStrictEqual({ ok: false, failure: "unavailable" });
    expect(value.every((byte) => byte === 0)).toBe(true);
  });

  it.each([0x1f, 0x7f] as const)(
    "wipes and refuses an access code containing byte 0x%s",
    async (byte) => {
      const value = new Uint8Array([0x41, byte, 0x41]);
      const { raw } = nativeInput({ value });
      const result = await bindNativeSecureInput(raw).request("access-code", "l");
      expect(result).toStrictEqual({ ok: false, failure: "unavailable" });
    },
  );

  it("returns the bytes a valid short-id submission carried", async () => {
    const { raw } = nativeInput({ value: new TextEncoder().encode("A1B2C3D4") });
    const result = await bindNativeSecureInput(raw).request("short-id", "卡号");
    expect(result).toStrictEqual({ ok: true, value: new TextEncoder().encode("A1B2C3D4") });
  });

  it.each([
    ["a1b2c3d4", "lower-case"],
    ["A1B2C3D", "seven characters"],
    ["A1B2C3D4E", "nine characters"],
    ["A1B2C3G4", "a non-hex character"],
  ] as const)("wipes and refuses %s as a short id (%s)", async (text, _name) => {
    const { raw } = nativeInput({ value: new TextEncoder().encode(text) });
    const result = await bindNativeSecureInput(raw).request("short-id", "l");
    expect(result).toStrictEqual({ ok: false, failure: "unavailable" });
  });

  it("resolves cancelled when the request was cancelled", async () => {
    const { raw } = nativeInput({ code: "cancelled" });
    const result = await bindNativeSecureInput(raw).request("access-code", "l");
    expect(result).toStrictEqual({ ok: false, failure: "cancelled" });
  });

  it("maps unavailable and unknown codes to unavailable", async () => {
    const { raw } = nativeInput({ code: "exploded" });
    const result = await bindNativeSecureInput(raw).request("short-id", "l");
    expect(result).toStrictEqual({ ok: false, failure: "unavailable" });
  });

  it("maps a missing outcome to unavailable", async () => {
    const { raw } = nativeInput({});
    const result = await bindNativeSecureInput(raw).request("access-code", "l");
    expect(result).toStrictEqual({ ok: false, failure: "unavailable" });
  });

  it("forwards cancel to the native side", () => {
    const { raw, seen } = nativeInput({});
    bindNativeSecureInput(raw).cancel();
    expect(seen.cancels).toBe(1);
  });
});
