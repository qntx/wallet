import type {
  ConnectionOrigin,
  PendingRequest,
  RequestOrigin,
  RiskFinding,
  WalletEngine,
} from "@qntx/wallet-engine";
import { requiredAcknowledgement } from "@qntx/wallet-engine";
import type { WalletConnect } from "@qntx/wallet-engine/walletconnect";

/**
 * `RequestOrigin` and `ConnectionOrigin` gained a `"walletconnect"` kind. A switch that only knew
 * `browser`/`internal` silently mislabels WalletConnect peers — render the peer's self-declared
 * `name`/`url` and its Verify status instead.
 */
export function originLabel(origin: RequestOrigin | ConnectionOrigin): string {
  if (origin.kind === "internal") {
    return "this app";
  }
  if (origin.kind === "browser") {
    return origin.origin;
  }
  if (origin.kind === "app") {
    return `app: ${origin.id}`;
  }
  // kind === "walletconnect" — a future origin kind stops compiling here until it is rendered.
  return `${origin.name} <${origin.url}> — verify ${origin.verify.validation}${
    origin.verify.isScam ? ", reported scam" : ""
  }`;
}

/**
 * `payments.parse` now returns `{ kind: "walletconnect", uri }` for `wc:` URIs (in addition to
 * `nostr+walletconnect:`). Pair it; keep the previous branches for everything else.
 */
export async function handleScanned(
  engine: WalletEngine,
  walletConnect: WalletConnect,
  text: string,
  network: "mainnet" | "regtest",
): Promise<void> {
  const parsed = engine.payments.parse(text, network);
  switch (parsed.kind) {
    case "walletconnect":
      await walletConnect.pair(parsed.uri);
      break;
    case "request":
      break; // existing payment-request handling
    default:
      throw new Error(`cannot handle scanned text (${parsed.kind})`);
  }
}

/**
 * User rejection from the injected Solana and Bitcoin providers surfaced as a -32603 internal
 * error; it is now EIP-1193's 4001, matching eip1193. Host dApp shims that matched -32603 for
 * rejection must match 4001 instead.
 */
export function isUserRejectionBefore(error: { readonly code?: number }): boolean {
  // Dead code now: 0.13.0 emitted -32603 for a rejected Solana/Bitcoin request.
  return error.code === -32_603;
}

/** The user-rejection check for the injected providers, all three families. */
export function isUserRejection(error: { readonly code?: number }): boolean {
  return error.code === 4001;
}

/**
 * `bitcoin:signAndSendTransaction` entries gained the signed PSBT next to the txid — the host gets
 * `{ txId, signedPsbt }[]` (previously `{ txId }[]`). Use `signedPsbt` for fee/display detail or
 * delayed rebroadcast; `txId` is unchanged.
 */
export function broadcastResultLabel(entry: { txId: string; signedPsbt: Uint8Array }): string {
  return `tx ${entry.txId} (${entry.signedPsbt.length} bytes signed)`;
}

/** The two new WalletConnect Verify findings, for a risk acknowledgement list. */
const VERIFY_LABELS: Partial<Record<RiskFinding["code"], string>> = {
  "verify-threat": "WalletConnect Verify flags this dApp as a scam",
  "verify-mismatch": "the dApp's domain does not match its WalletConnect registration",
};

/**
 * `verify-mismatch` and `verify-threat` join `request.risk` (and `WalletConnectProposal.risk`) as
 * `danger` findings — `approve` refuses until `acknowledged` names them.
 */
export function acknowledgementLines(request: Pick<PendingRequest, "risk" | "checks">): string[] {
  const required = requiredAcknowledgement(request);
  return [
    ...required.risk.map((code) => VERIFY_LABELS[code] ?? `confirm ${code}`),
    ...required.checks.map((code) => `confirm check ${code}`),
  ];
}
