import type {
  AccountRef,
  SignatureResult,
  SignedTransactionResult,
  TrackedTransaction,
  WalletEngine,
} from "@qntx/wallet-engine";
import type { BrowserBridge } from "@qntx/wallet-engine/connect";
import { createBrowserBridge } from "@qntx/wallet-engine/connect";

const account: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44",
};

/**
 * `BrowserBridgeOptions` gained a required `tron` handler — `engine.tronWallet`, next to
 * `solanaWallet`/`bitcoinWallet`. It answers the injected `window.tron`/`tronLink`/`tronWeb`
 * surface; a bridge built without it no longer compiles.
 */
export function browserBridge(
  engine: WalletEngine,
  inject: (script: string) => void,
): BrowserBridge {
  return createBrowserBridge({
    eip1193: engine.eip1193,
    nip07: engine.nip07,
    webln: engine.webln,
    solana: engine.solanaWallet,
    bitcoin: engine.bitcoinWallet,
    tron: engine.tronWallet,
    connections: engine.connections,
    inject,
    now: () => Date.now(),
  });
}

/**
 * A dApp TRON request arrives as `tron-sign`. The outcome is a `TrackedTransaction` for a
 * transaction — created in `submitted` with `tron.dappSignature` and no `raw`, because the dApp
 * broadcasts and the wallet only observes — or a `SignatureResult` for `tron.message` /
 * `tron.typed-data`. A scanned QR request's outcome is a `SignedTransactionResult` instead: the
 * counterpart broadcasts the signed bytes itself. When the dApp hands the signed transaction back
 * for broadcast it calls the injected `tronWeb.trx.sendRawTransaction`, which routes through the
 * bridge to `submitDappTron` on the same tracked entry — there is no host-side broadcast call to
 * wire.
 */
export async function approveTronDapp(
  engine: WalletEngine,
  requestId: string,
): Promise<TrackedTransaction | SignatureResult | SignedTransactionResult> {
  return engine.requests.approve(requestId, "tron-sign", {
    verify: { kind: "password", password: "…" },
  });
}

/** A transaction `tron-sign` result carries the observed signature and no broadcast bytes. */
export function observedDappSignature(tx: TrackedTransaction): string | undefined {
  return tx.tron?.dappSignature;
}

/**
 * `connections` gains `setTronNetwork` next to `setCurrentNetwork`: the host's session UI switches
 * a connected origin's TRON network (voiding that origin's unfinished requests) the same way it
 * switches an EVM session's.
 */
export async function switchTronSessionNetwork(
  engine: WalletEngine,
  origin: string,
): Promise<void> {
  await engine.connections.setTronNetwork(origin, "tron:3448148188");
}

/**
 * `send` gains a TRON-only `memo` — it becomes `raw_data.data` and costs the chain's flat memo fee,
 * quoted as `PendingRequest.tronFee.memo` (sun, decimal string).
 */
export async function sendTronWithMemo(
  engine: WalletEngine,
  to: string,
  amount: bigint,
): Promise<string> {
  const pending = await engine.requests.prepare({
    method: "send",
    account,
    network: "tron:728126428",
    to,
    amount,
    fee: "normal",
    memo: "qntx",
  });
  return pending.tronFee?.memo ?? "0";
}
