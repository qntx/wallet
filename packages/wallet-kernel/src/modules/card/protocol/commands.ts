/**
 * Inner command vocabulary (protocol.md §9). `Inner` is the plaintext record a session wraps:
 * `INS ‖ P1 ‖ P2 ‖ data` with `|data| ≤ 236` (§8.4). The `cmd.*` builders are added with the
 * command layer.
 */
export type CommandName =
  | "status"
  | "create"
  | "verify"
  | "change"
  | "erase"
  | "wait"
  | "public-key"
  | "sign-ecdsa"
  | "sign-bip340"
  | "ed25519-begin"
  | "ed25519-update"
  | "ed25519-finish"
  | "offer"
  | "export-head"
  | "export-payload"
  | "import-head"
  | "import-payload";

export type Inner = {
  readonly name: CommandName;
  readonly ins: number;
  readonly p1: number;
  readonly p2: number;
  readonly data: Uint8Array;
};
