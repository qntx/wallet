import type { VerifyFactor } from "@qntx/wallet";
import type {
  HistoryControllerOptions,
  SignersController,
  TransactionController,
} from "@qntx/wallet-engine";
import type { QrExportParams } from "@qntx/wallet-engine/qr";
import type { ChainAccount, ChainSignRequest } from "@qntx/wallet/chains";
import type { DeviceIo, HardwareApi, HardwareResult } from "@qntx/wallet/hardware";

/**
 * Signer confirmation and the sealed change mark (section 35): `bitcoin.psbt` requests carry a
 * required `origin`; every `ChainAccount` reports `confirmed` and the bitcoin variant adds
 * `changeMark`; fetches that add device keys take a `verify`; exports of — and Bitcoin sends to —
 * unconfirmed material need `acknowledgeUnconfirmed`; `nextReceiveAddress` returns `{ address,
 * confirmed }`; and a host-wired history `chains.account` answers the xpub variant with
 * `changeMark` and `confirmed`. Compiled only.
 */

/** Every `bitcoin.psbt` request declares where it came from — only "internal" raises the mark. */
export function psbtOrigin(request: ChainSignRequest): "internal" | "external" | undefined {
  return request.kind === "bitcoin.psbt" ? request.origin : undefined;
}

/** `confirmed` names an on-device check; `changeMark` is the sealed change bound (bitcoin). */
export function accountState(account: ChainAccount): {
  confirmed: boolean;
  changeMark: number | undefined;
} {
  return {
    confirmed: account.confirmed,
    changeMark: "changeMark" in account ? account.changeMark : undefined,
  };
}

/** Pairing and key-adding account fetches need a verification the host collects first. */
export function startPair(api: HardwareApi, verify: VerifyFactor): void {
  void api;
  void verify;
  // api.start({ kind: "pair", device }, { io, verify }) — verify is required.
}

/** `fetchAccounts` accepts the same `verify` and may answer `approval-required` without it. */
export function refetch(signers: SignersController, verify: VerifyFactor): void {
  void signers.fetchAccounts({
    walletId: "w",
    groupIndex: 1,
    family: "evm",
    verify,
  });
}

/** Exporting unconfirmed material needs the explicit acknowledgement. */
export function exportParams(verify: VerifyFactor): QrExportParams {
  return {
    account: { walletId: "w", groupIndex: 0 },
    form: "crypto-hdkey",
    verify,
    acknowledgeUnconfirmed: true,
  };
}

/** The receive address arrives with its confirmation state — show "unconfirmed" when false. */
export async function receive(
  transactions: TransactionController,
): Promise<{ address: string; confirmed: boolean }> {
  return transactions.nextReceiveAddress("w", 0, "bitcoin");
}

/** A send to a key the device never confirmed: show the danger row first, then acknowledge it. */
export async function signUnconfirmed(
  api: HardwareApi,
  io: DeviceIo,
  request: ChainSignRequest,
  verify: VerifyFactor,
): Promise<HardwareResult> {
  const op = api.start({ kind: "sign", request, acknowledgeUnconfirmed: true }, { io, verify });
  return op.result;
}

/** A host-wired history account: the xpub variant reports the sealed mark and confirmation. */
export const historyAccount: HistoryControllerOptions["chains"]["account"] = async (params) => {
  void params;
  await Promise.resolve();
  return { xpub: "xpub…", changeMark: 0, confirmed: false };
};
