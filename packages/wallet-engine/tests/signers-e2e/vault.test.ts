/**
 * Engine e2e sends through the vault backends: the imported mnemonic wallet and a passkey wallet
 * each run the shared origins × families matrix (internal send, dApp, QR) against the hermetic
 * stubs, every signature verified with the independent oracles. No device hop — the proof is that
 * the three origins reach the kernel identically.
 */
import { describe } from "vite-plus/test";

import { VERIFY, nodeWallet } from "../apps-helpers.ts";
import { e2eWorld, matrix, matrixAccount } from "./harness.ts";

describe("vault backends", () => {
  matrix("mnemonic", VERIFY, async () => {
    const e2e = await e2eWorld({});
    const account = await matrixAccount(e2e.w, e2e.w.walletId);
    return { e2e, account };
  });

  matrix("passkey", VERIFY, async () => {
    const { wallet } = await nodeWallet();
    const passkey = await wallet.wallets.createWithPasskey({ name: "e2e passkey" });
    const e2e = await e2eWorld({ wallet: { wallet, walletId: passkey.walletId } });
    const account = await matrixAccount(e2e.w, passkey.walletId);
    return { e2e, account };
  });
});
