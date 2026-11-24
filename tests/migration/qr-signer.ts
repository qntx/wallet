import type { Wallet } from "@qntx/wallet";
import type {
  BitcoinPsbtInput,
  EngineOptions,
  PendingRequest,
  RequestOrigin,
  WalletEngine,
  DeviceTransport,
} from "@qntx/wallet-engine";
import { createQrScanner, qrFrames, qrSigner, readQrRequest } from "@qntx/wallet-engine/qr";
import type { QrExport } from "@qntx/wallet-engine/qr";

/**
 * `RequestOrigin` gains `{ kind: "qr", declared? }` — a request that entered through a scanned UR
 * frame. Every switch on `RequestOrigin["kind"]` must name it: a scanned request is attributed to
 * the counterpart's self-declared `origin` (display-only, untrusted), never to a dApp session.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export function originBadge(origin: RequestOrigin): string {
  switch (origin.kind) {
    case "internal":
      return "this app";
    case "browser":
      return origin.origin;
    case "walletconnect":
      return origin.name;
    case "app":
      return origin.id;
    case "qr":
      return origin.declared ?? "scanned QR request";
  }
}

/**
 * `BitcoinPsbtInput.sign[].template` widened from the two dApp-facing templates to all four — a QR
 * counterpart may ask for `btc.bip44` or `btc.bip49` inputs too. A host that rendered or filtered
 * PSBT inputs by template must expect every member.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export function psbtTemplateLabel(template: BitcoinPsbtInput["sign"][number]["template"]): string {
  switch (template) {
    case "btc.bip44":
      return "legacy";
    case "btc.bip49":
      return "wrapped segwit";
    case "btc.bip84":
      return "native segwit";
    case "btc.bip86":
      return "taproot";
  }
}

/**
 * `EngineOptions.devices` routes hardware-custody accounts' signatures — for every origin, QR
 * included — through the host's device transport. Called once per signature; the io's `signal` is
 * how the pipeline cancels a tap. Without it, hardware wallets fail `device-required`.
 */
export function engineOptions(devices: DeviceTransport): Pick<EngineOptions, "devices"> {
  return { devices };
}

/**
 * The phone side of a QR session: decode the counterpart's frames, prepare an ordinary engine
 * request, let the user approve it, answer with the signature frames. Progress on the wire is the
 * scanner's ratio; the request's stage moves `awaiting-approval` → `signed` on its own.
 */
export async function answerQrRequest(
  engine: WalletEngine,
  wallet: Wallet,
  account: { walletId: string; groupIndex: number },
  readFrame: () => Promise<string>,
): Promise<PendingRequest> {
  const scanner = createQrScanner({ kind: "request", now: () => Date.now() });
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- frames arrive one camera read at a time
    const outcome = scanner.receive(await readFrame());
    if (outcome.status === "complete") {
      const { payload } = outcome;
      const signer = qrSigner({ engine, wallet });
      return signer.prepare(readQrRequest(payload), account);
    }
  }
}

/**
 * After the user approves `pending.id` through the usual pipeline, `respond` encodes the UR answer;
 * the host animates `qrFrames` until the counterpart has every part.
 */
export async function qrAnswerFrames(
  engine: WalletEngine,
  wallet: Wallet,
  requestId: string,
): Promise<() => string> {
  const payload = await qrSigner({ engine, wallet }).respond(requestId);
  return qrFrames(payload);
}

/** Show the account export QR: what it discloses belongs in the prompt. */
export async function exportForWatch(
  engine: WalletEngine,
  wallet: Wallet,
  account: { walletId: string; groupIndex: number },
  verify: { kind: "password"; password: string },
): Promise<{ frames: () => string; discloses: QrExport["discloses"] }> {
  const out = await qrSigner({ engine, wallet }).exportAccount({
    account,
    form: "crypto-multi-accounts",
    families: ["evm", "solana", "tron"],
    verify,
  });
  return { frames: qrFrames(out.payload), discloses: out.discloses };
}
