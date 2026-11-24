/**
 * Proof of concept (asserts the current, flawed behaviour): `inspectQrRequest` labels the
 * `eip712-digest` and `eip191-digest` digests with `shownBy: ["ledger-ethereum"]`, claiming a
 * Ledger device displays them. The lane's research (wallet-audit/n10/qr-signer/research.md) sources
 * only the transaction hash and the EIP-712 domain/message hashes as device-shown — the host can
 * therefore present a digest the counterpart could never have verified on its screen.
 */
import { describe, expect, it } from "vite-plus/test";

import { inspectQrRequest } from "../../src/qr/index.ts";
import type { QrRequest } from "../../src/qr/index.ts";

const HARDENED = 0x80000000;
const PATH = [44 + HARDENED, 60 + HARDENED, HARDENED, 0, 0];
const XFP = 0x73c5da0a;
const TYPED_DATA = JSON.stringify({
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Mail: [{ name: "contents", type: "string" }],
  },
  primaryType: "Mail",
  domain: { name: "Test" },
  message: { contents: "hello" },
});

const digest = (request: QrRequest, kind: string) =>
  inspectQrRequest(request).digests.find((d) => d.kind === kind);

describe("inspectQrRequest labels digests as device-shown that a Ledger never shows", () => {
  it("eip712-digest carries shownBy ledger-ethereum beside the two sourced hashes", () => {
    const request: QrRequest = {
      family: "evm",
      kind: "typed-data",
      path: PATH,
      xfp: XFP,
      typedData: TYPED_DATA,
    };
    const inspection = inspectQrRequest(request);
    expect(inspection.digests.map((d) => d.kind)).toStrictEqual([
      "eip712-domain-hash",
      "eip712-message-hash",
      "eip712-digest",
    ]);
    for (const d of inspection.digests) {
      expect(d.shownBy).toStrictEqual(["ledger-ethereum"]);
    }
    expect(digest(request, "eip712-digest")?.shownBy).toStrictEqual(["ledger-ethereum"]);
  });

  it("eip191-digest carries shownBy ledger-ethereum", () => {
    const request: QrRequest = {
      family: "evm",
      kind: "personal-message",
      path: PATH,
      xfp: XFP,
      message: new TextEncoder().encode("hello"),
    };
    expect(digest(request, "eip191-digest")?.shownBy).toStrictEqual(["ledger-ethereum"]);
  });
});
