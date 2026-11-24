/**
 * Shared fixture for the card-surfaces probe and the leak checker. Only
 * `card-surfaces.ts` (kernel side) and `scripts/card-leak-check.ts` (host side)
 * import this — nothing under apps/harness/src may: values that exist in the
 * main runtime would make the leak check meaningless.
 */

/** What the driver types into the secure field for `access-code`. */
export const ACCESS_CODE = "Qx7harnessCode42";

/** The card's printed form (kernel puts it in the access-code label). */
export const SHORT_ID_PRINTED = "1A2B-3C4D";
/** What the driver types — lower case and dashed on purpose. */
export const SHORT_ID_TYPED = "1a2b-3c4d";
/** The bytes the kernel expects after the field normalises. */
export const SHORT_ID_NORMALIZED = "1A2B3C4D";

/** What the driver types into the secure field for `session-approval`. */
export const SESSION_APPROVAL_CODE = "0427";

/** Typed into the plain TextInput — the checker's positive control. */
export const DECOY = "decoyMainRuntime91";

/** Kernel-built labels/prompts; the main runtime never supplies these. */
export const ACCESS_CODE_LABEL = `Enter the access code for card ${SHORT_ID_PRINTED}`;
export const SHORT_ID_LABEL = "Type the 8-character ID printed on the card";
export const SESSION_APPROVAL_LABEL = `Approve agent "bot-1" on Mainnet\nBuy budget: 100\nType ${SESSION_APPROVAL_CODE} below to approve these limits`;
export const TAP_PROMPT = "Tap to sign on Ethereum: send 0.5 ETH to 0xAbC1…9F3e (harness)";
export const DEVICE_TAP_PROMPT = "Tap the qntx card to read its ID (harness)";

/** SELECT of the qntx instance AID F0716E74780101 (protocol.md §2). */
export const SELECT_AID_APDU = new Uint8Array([
  0x00, 0xa4, 0x04, 0x00, 0x07, 0xf0, 0x71, 0x6e, 0x74, 0x78, 0x01, 0x01, 0x00,
]);

/** APDU whose INS (0xEE) makes the fake reader report tag loss. */
export const TAG_LOST_APDU = new Uint8Array([0x00, 0xee, 0x00, 0x00, 0x00]);

/** Two ordinary commands the fake answers with reversed data ‖ 90 00. */
export const ECHO_APDUS = [
  new Uint8Array([0x00, 0x10, 0x00, 0x00, 0x03, 0xaa, 0xbb, 0xcc]),
  new Uint8Array([0x00, 0x20, 0x01, 0x02, 0x04, 0xde, 0xad, 0xbe, 0xef]),
];
