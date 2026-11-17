/**
 * Audit A1 / chains-signing PoC CS: a Solana transaction-v1 message (SIMD-0385, prefix 0x81) is not
 * recognised as a transaction by `parseCompiledMessage`, so `normalizeSolana` accepts it as a raw
 * `solana.message` and the signer produces a signature that authorises the v1 transaction.
 *
 * Layout source: solana-message 6.0.0 `src/versions/v1/message.rs:1130-1146` (serialize fixture) and
 * agave-transaction-view 10.1.0 `message_frame.rs:try_new_as_v1`, `transaction_frame.rs:try_new_as_v1`
 * (a v1 transaction is `message ‖ signatures`; sigverify checks `message_data()` = the message bytes).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { getAddressEncoder } from "@solana/addresses";
import { getCompiledTransactionMessageDecoder } from "@solana/transaction-messages";
import { describe, expect, it } from "vite-plus/test";

import { isBlindIntent, messageContent } from "../../src/index.ts";
import { normalizeSolana } from "../../src/solana/index.ts";
import { solanaAddressFromPublicKey } from "../../src/solana/ids.ts";
import { parseCompiledMessage } from "../../src/solana/message.ts";
import { signSolanaMessage } from "../../src/solana/sign.ts";

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" } as const;
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SYSTEM = "11111111111111111111111111111111";

const priv = new Uint8Array(32).fill(7);
const signer = solanaAddressFromPublicKey(ed25519.getPublicKey(priv));
const attacker = solanaAddressFromPublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const enc = getAddressEncoder();

/** A v1 message: SystemProgram.transfer(signer → attacker, lamports), no config values. */
export const v1TransferMessage = (blockhash: Uint8Array, lamports: bigint): Uint8Array => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer
  view.setBigUint64(4, lamports, true);
  const bytes = [
    0x81, // V1_PREFIX = MESSAGE_VERSION_PREFIX | 1
    1, // num_required_signatures
    0, // num_readonly_signed
    1, // num_readonly_unsigned (system program)
    0, 0, 0, 0, // TransactionConfigMask = 0
    ...blockhash, // LifetimeSpecifier
    1, // NumInstructions
    3, // NumAddresses
    ...enc.encode(signer as never),
    ...enc.encode(attacker as never),
    ...enc.encode(SYSTEM as never),
    2, // program_id_index
    2, // num_accounts
    12, 0, // data_len (u16 LE)
    0, 1, // account indices
    ...data,
  ];
  return Uint8Array.from(bytes);
};

describe("CS: Solana v1 transaction message signed as a raw solana.message", () => {
  const message = v1TransferMessage(new Uint8Array(32).fill(0xab), 5_000_000_000n);

  it("the independent kit decoder reads the bytes as a complete version-1 transaction message", () => {
    const [decoded, end] = getCompiledTransactionMessageDecoder().read(message, 0);
    expect(end).toBe(message.length);
    expect((decoded as { version: unknown }).version).toBe(1);
    expect((decoded as { staticAccounts: string[] }).staticAccounts[0]).toBe(signer);
  });

  it("parseCompiledMessage does not treat it as a transaction", () => {
    expect(() => parseCompiledMessage(message)).toThrow(/failed to decode/);
  });

  it("normalizeSolana accepts it as a raw message and the signature authorises the v1 transaction", () => {
    const request = { kind: "solana.message", network: NETWORK, account: ACCOUNT, message, format: "raw" };
    const normalized = normalizeSolana(request, signer);
    expect(normalized.kind).toBe("solana.message");
    // The kernel prompt for it is the generic blind prompt — gated only by the blind-signing policy.
    expect(isBlindIntent({ verifiability: "opaque", message: messageContent(message, "solana") })).toBe(
      true,
    );
    const signature = signSolanaMessage(message, priv);
    // v1 wire transaction = message ‖ signatures; sigverify checks the signature over the message.
    const transaction = Uint8Array.from([...message, ...signature]);
    expect(transaction.length).toBe(message.length + 64);
    expect(ed25519.verify(signature, message, enc.encode(signer as never) as Uint8Array)).toBe(true);
  });
});
