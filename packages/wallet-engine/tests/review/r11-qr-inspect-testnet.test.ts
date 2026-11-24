/**
 * Proof of concept (asserts the current, flawed behaviour): `inspectQrRequest` frames every PSBT
 * through `bitcoinProbe` with the mainnet coder, because a PSBT carries no declared network. A
 * testnet PSBT — input derivations under coin type 1' — is therefore rendered with `bc1…` addresses
 * where the signing device will show `tb1…`, so the inspection display cannot be what the
 * counterpart verified on its screen.
 */
import { Address, NETWORK, OutScript, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { inspectQrRequest } from "../../src/qr/index.ts";
import type { QrRequest } from "../../src/qr/index.ts";

const HARDENED = 0x80000000;

/** A one-input testnet PSBT paying a p2wpkh output, derivations under coin type 1'. */
const testnetPsbt = (): Uint8Array => {
  const spent = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x02)]);
  const payee = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x03)]);
  const tx = new Transaction();
  tx.addInput({
    txid: new Uint8Array(32).fill(0x07),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: spent, amount: 100_000n },
    bip32Derivation: [
      [
        new Uint8Array(33).fill(2),
        { fingerprint: 0x73c5da0a, path: [84 + HARDENED, 1 + HARDENED, HARDENED, 0, 0] },
      ],
    ],
  });
  tx.addOutput({ script: payee, amount: 90_000n });
  return tx.toPSBT(0);
};

describe("inspectQrRequest frames a testnet PSBT with mainnet addresses", () => {
  it("renders the tb1 payee output as its bc1 mainnet encoding", () => {
    const request: QrRequest = {
      family: "bitcoin",
      kind: "psbt",
      urType: "psbt",
      psbt: testnetPsbt(),
    };
    const out = inspectQrRequest(request);
    const flow = out.display?.outflows[0];
    expect(flow?.to).toMatch(/^bc1/);
    /* The shown string is exactly the mainnet encoding of the same output script. */
    const script = Transaction.fromPSBT(request.psbt).getOutput(0).script!;
    expect(flow?.to).toBe(Address(NETWORK).encode(OutScript.decode(script)));
    expect(flow?.to).not.toMatch(/^tb1/);
  });
});
