/**
 * Proof of concept (asserts the current, flawed behaviour): a scanned QR request carries no
 * verifiable page origin, so `signInRisk` skips the Sign-In-with-Ethereum domain check entirely and
 * attaches only the warning `qr-sign-in-unverified`. A QR counterpart can therefore obtain a
 * signature over a SIWE message claiming a domain it does not own (`app.uniswap.org`) with no
 * acknowledgement at all — the same message from a browser origin is refused at prepare with
 * `SignInOriginError`. A warning the user may swipe past replaces a refusal.
 */
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "@qntx/wallet-chains";

import { SignInOriginError } from "../../src/requests/types.ts";
import { ACCOUNT, ADDR, evmSign, evmWorld, SIGNATURE, VERIFY } from "./r11-helpers.ts";

const QR = { kind: "qr" as const };

const SIWE_BODY = [
  "app.uniswap.org wants you to sign in with your Ethereum account:",
  ADDR,
  "",
  "Sign in",
  "",
  "URI: https://app.uniswap.org/login",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: 12341234abcd",
  "Issued At: 2026-11-17T12:45:13.610Z",
].join("\n");

const qrMessage = (message: Uint8Array): SignRequest => ({
  kind: "evm.personal-message",
  network: "eip155:1",
  account: ACCOUNT,
  message,
});

describe("a QR-origin sign-in message for a foreign domain", () => {
  it("prepares with only a warning and signs without any acknowledgement", async () => {
    const w = evmWorld();
    await w.start();
    const message = new TextEncoder().encode(SIWE_BODY);
    const request = await w.requests.prepare({ ...evmSign(qrMessage(message)), origin: QR });
    expect(request.risk).toStrictEqual([{ code: "qr-sign-in-unverified", level: "warning" }]);
    /* No `acknowledged` option at all: a warning never reaches the acknowledgement rule. */
    const result = await w.requests.approve(request.id, "evm-sign", { verify: VERIFY });
    expect(result).toStrictEqual({ kind: "evm.personal-message", signature: SIGNATURE });
  });

  it("the same message from a browser origin is refused at prepare", async () => {
    const w = evmWorld();
    await w.start();
    const message = new TextEncoder().encode(SIWE_BODY);
    await expect(
      w.requests.prepare({
        ...evmSign(qrMessage(message)),
        origin: { kind: "browser", origin: "https://evil.example" },
      }),
    ).rejects.toBeInstanceOf(SignInOriginError);
  });
});
