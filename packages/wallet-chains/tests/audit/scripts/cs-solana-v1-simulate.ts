/**
 * Read-only network confirmation for the Solana v1 PoC: simulateTransaction with sigVerify=true
 * (nothing is broadcast). A valid signature passes sigverify and fails later (unfunded fee payer);
 * a tampered signature fails sigverify. Usage: bun tests/audit/scripts/cs-solana-v1-simulate.ts <rpc>
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { getAddressEncoder } from "@solana/addresses";
import { base58 } from "@scure/base";

import { normalizeSolana } from "../../../src/solana/index.ts";
import { solanaAddressFromPublicKey } from "../../../src/solana/ids.ts";
import { signSolanaMessage } from "../../../src/solana/sign.ts";

const rpc = process.argv[2] ?? "https://api.devnet.solana.com";
const call = async (method: string, params: unknown[]) =>
  (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;

const priv = new Uint8Array(32).fill(7);
const signer = solanaAddressFromPublicKey(ed25519.getPublicKey(priv));
const attacker = solanaAddressFromPublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const enc = getAddressEncoder();
const { result } = await call("getLatestBlockhash", [{ commitment: "confirmed" }]);
const blockhash = base58.decode(result.value.blockhash);
const data = new Uint8Array(12);
new DataView(data.buffer).setUint32(0, 2, true);
new DataView(data.buffer).setBigUint64(4, 1000n, true);
const message = Uint8Array.from([0x81, 1, 0, 1, 0, 0, 0, 0, ...blockhash, 1, 3,
  ...enc.encode(signer as never), ...enc.encode(attacker as never),
  ...enc.encode("11111111111111111111111111111111" as never), 2, 2, 12, 0, 0, 1, ...data]);
normalizeSolana({ kind: "solana.message", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" }, message, format: "raw" }, signer);
console.log("normalizeSolana accepted the v1 message as solana.message; signer", signer);
const signature = signSolanaMessage(message, priv);
for (const [label, sig] of [["valid", signature], ["tampered", Uint8Array.from(signature, (b, i) => (i === 0 ? b ^ 1 : b))]] as const) {
  const tx = Buffer.from([...message, ...sig]).toString("base64");
  const out = await call("simulateTransaction", [tx, { encoding: "base64", sigVerify: true }]);
  console.log(label, JSON.stringify(out.error ?? out.result?.value?.err ?? out.result?.value).slice(0, 300));
}
