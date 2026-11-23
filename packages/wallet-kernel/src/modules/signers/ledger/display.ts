import { parseCompiledMessage, PROGRAM_IDS } from "@qntx/wallet-chains/solana";
/**
 * What the device would show for a request: `clear` only when the pinned app renders the full
 * request natively without a setting, `blind` when it signs behind a setting or a hash, and
 * `unsupported` when the pinned build cannot serve the request at all. The rule of thumb: claiming
 * `clear` for what the device would blind-sign is the bug to avoid — `blind` is the safe answer.
 *
 * Verified against the pinned app sources:
 *
 * - Ethereum 1.24.0: tx without calldata renders the review flow; calldata or creation needs "Blind
 *   signing"; EIP-712 shows domain fields + message hash only; EIP-7702 is not in the default build
 *   (EIP7702_SUPPORT ?= 0).
 * - Tron 0.8.2 (src/handlers/sign.c): dedicated screens exist for the contract types listed below —
 *   anything else falls to APPROVAL_SIMPLE_TRANSACTION behind "Sign by hash"; a data memo needs
 *   "Allow data" (parse.c USTREAM_MISSING_SETTING_DATA_ALLOWED); a TriggerSmartContract that is not
 *   a TRC20 transfer/approve needs "Custom contracts"; a contract call carrying TRX/TRC10 value
 *   with a TRC20 selector is refused outright (E_INCORRECT_DATA).
 * - Solana 1.16.0: the app renders System Program transfers; every other instruction is a blind sign
 *   (handle_sign_offchain_message.c / libsol parser); off-chain messages are the v0 `\xffsolana
 *   offchain` document — format 0 restricted-ASCII shows text, format 1 UTF-8 shows a hash behind
 *   the blind setting.
 * - Bitcoin 2.5.1: a default-wallet PSBT renders its own address/amount review; mixed-template inputs
 *   cannot form one policy; message signing renders printable ASCII only.
 */
import { decodeTronContract, decodeTronRawData } from "@qntx/wallet-chains/tron";
import type { TronContract, TronContractSlot } from "@qntx/wallet-chains/tron";
import type { ChainSignRequest, DeviceDisplay } from "@qntx/wallet/protocol";

import type { ChainPlan } from "../../chains/run.ts";

/** TRC20 selectors the device ABI-decodes to a token screen (parse.c SELECTOR). */
const TRC20_SELECTORS = [
  Uint8Array.of(0xa9, 0x05, 0x9c, 0xbb), // transfer(address,uint256)
  Uint8Array.of(0x09, 0x5e, 0xa7, 0xb3), // approve(address,uint256)
] as const;

/**
 * Contract types with a dedicated approval screen on the pinned app (sign.c's ux_flow_display
 * switch). Not listed: CancelAllUnfreezeV2Contract — the app has no case for it, so it signs behind
 * "Sign by hash".
 */
const DEDICATED_CONTRACTS: ReadonlySet<string> = new Set<TronContract["type"]>([
  "TransferContract",
  "TransferAssetContract",
  "VoteWitnessContract",
  "FreezeBalanceV2Contract",
  "UnfreezeBalanceV2Contract",
  "WithdrawExpireUnfreezeContract",
  "DelegateResourceContract",
  "UnDelegateResourceContract",
  "WithdrawBalanceContract",
  "AccountPermissionUpdateContract",
]);

/** Whether a TriggerSmartContract is a TRC20 transfer/approve the device ABI-decodes. */
export const isTrc20Call = (
  contract: Extract<TronContract, { type: "TriggerSmartContract" }>,
): boolean => {
  const { data } = contract;
  return (
    data.length === 4 + 64 && TRC20_SELECTORS.some((sel) => sel.every((b, i) => data[i] === b))
  );
};

const OFFCHAIN_DOMAIN = Uint8Array.of(0xff, ...new TextEncoder().encode("solana offchain"));

/** Printable-ASCII per the app: 0x20..0x7e plus LF (libsol/string_utils.c is_data_ascii). */
const isAscii = (bytes: Uint8Array): boolean =>
  bytes.every((b) => (b >= 0x20 && b <= 0x7e) || b === 0x0a);

/**
 * The v0 off-chain message the pinned app accepts: `ff"solana offchain" ‖ version 0 ‖ appDomain 32
 * ‖ format ≤1 ‖ signerCount ≥1 ‖ signers ‖ len(u16 LE) ‖ message`, message length matching exactly.
 * Returns the message body or `undefined` when the bytes are not that document.
 */
const offchainMessage = (message: Uint8Array): Uint8Array | undefined => {
  const head = OFFCHAIN_DOMAIN.length + 1 + 32 + 1 + 1; // domain ‖ version ‖ appDomain ‖ format ‖ n
  if (message.length < head + 2) {
    return undefined;
  }
  if (!OFFCHAIN_DOMAIN.every((b, i) => message[i] === b) || message[16] !== 0x00) {
    return undefined;
  }
  const { 49: format, 50: signers } = message;
  if (format === undefined || format > 1 || signers === undefined || signers === 0) {
    return undefined;
  }
  const bodyAt = head + signers * 32;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  if (message.length < bodyAt + 2 || view.getUint16(bodyAt, true) !== message.length - bodyAt - 2) {
    return undefined;
  }
  return message.subarray(bodyAt + 2);
};

/**
 * The device settings a tron transaction needs (parse.c / sign.c): a `data` memo needs "Allow
 * data", a non-TRC20 TriggerSmartContract needs "Custom contracts", and any contract type without a
 * dedicated screen needs "Sign by hash".
 */
const contractType = (slot: TronContractSlot): string =>
  slot.typeUrl.slice(slot.typeUrl.lastIndexOf(".") + 1);

/** The decoded TriggerSmartContract of a raw transaction, or undefined for another/unknown slot. */
const tronTrigger = (rawData: Uint8Array) => {
  const slot = decodeTronRawData(rawData).contract;
  if (contractType(slot) !== "TriggerSmartContract") {
    return undefined;
  }
  const decoded = decodeTronContract(slot.typeId, slot.value)?.contract;
  return decoded?.type === "TriggerSmartContract" ? decoded : undefined;
};

export const tronSettings = (
  rawData: Uint8Array,
): { dataAllowed: boolean; customContracts: boolean; signByHash: boolean } => {
  const raw = decodeTronRawData(rawData);
  const type = contractType(raw.contract);
  const trigger = type === "TriggerSmartContract" ? tronTrigger(rawData) : undefined;
  return {
    dataAllowed: raw.memo !== undefined && raw.memo.length > 0,
    customContracts:
      type === "TriggerSmartContract" && (trigger === undefined || !isTrc20Call(trigger)),
    signByHash: type !== "TriggerSmartContract" && !DEDICATED_CONTRACTS.has(type),
  };
};

/**
 * Whether a decoded tron transaction is rendered by a dedicated screen with no setting: a dedicated
 * contract — or a TRC20 transfer/approve — and no `data` memo (data needs Allow data).
 */
export const tronClears = (rawData: Uint8Array): boolean => {
  const needs = tronSettings(rawData);
  if (needs.dataAllowed || needs.customContracts || needs.signByHash) {
    return false;
  }
  // A TRC20-shaped call that also moves TRX or a TRC10 token is refused outright, never shown.
  const trigger = tronTrigger(rawData);
  return trigger === undefined || (trigger.callValue === 0n && trigger.callTokenValue === 0n);
};

/** Whether a compiled solana message is all System transfers / ComputeBudget instructions. */
export const solanaClears = (message: Uint8Array): boolean => {
  const parsed = parseCompiledMessage(message);
  if (parsed.lookups.length > 0) {
    return false;
  }
  const { staticAccounts, instructions } = parsed;
  return instructions.every((ix) => {
    const program = staticAccounts[ix.programAddressIndex];
    if (program === PROGRAM_IDS.computeBudget) {
      return true;
    }
    if (program !== PROGRAM_IDS.system) {
      return false;
    }
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    return ix.data.length === 12 && view.getUint32(0, true) === 2; // Transfer
  });
};

/** The off-chain message classification the display needs. */
export const solanaOffchain = (message: Uint8Array): "ascii" | "utf8" | undefined => {
  const body = offchainMessage(message);
  if (body === undefined) {
    return undefined;
  }
  return isAscii(body) ? "ascii" : "utf8";
};

/** The device's display for a request: `clear` what firmware renders, refuse the rest. */
export const display = (
  request: ChainSignRequest,
  plan: ChainPlan,
): DeviceDisplay | "unsupported" => {
  if (plan.kind === "evm.transaction") {
    const { tx } = plan;
    if (tx.type === "eip7702") {
      return "unsupported"; // not in the pinned 1.24.0 default build
    }
    return tx.to !== undefined && (tx.data === "0x" || tx.data === "") ? "clear" : "blind";
  }
  if (plan.kind === "evm.personal-message" || plan.kind === "evm.fiat24-session") {
    return "clear";
  }
  if (plan.kind === "evm.typed-data") {
    return "blind";
  }
  if (plan.kind === "tron.transaction") {
    if (request.kind !== "tron.transaction") {
      return "unsupported";
    }
    return tronClears(request.rawData) ? "clear" : "blind";
  }
  if (plan.kind === "tron.message") {
    return "clear";
  }
  if (plan.kind === "tron.typed-data") {
    return "blind";
  }
  if (plan.kind === "solana.transaction") {
    if (request.kind !== "solana.transaction") {
      return "unsupported";
    }
    return solanaClears(request.message) ? "clear" : "blind";
  }
  if (plan.kind === "solana.message") {
    if (request.kind !== "solana.message") {
      return "unsupported";
    }
    const offchain = solanaOffchain(request.message);
    return offchain === undefined ? "unsupported" : offchain === "ascii" ? "clear" : "blind";
  }
  if (plan.kind === "bitcoin.psbt") {
    if (request.kind !== "bitcoin.psbt") {
      return "unsupported";
    }
    return new Set(request.sign.map((s) => s.template)).size === 1 ? "clear" : "unsupported";
  }
  if (
    plan.kind === "bitcoin.message" &&
    request.kind === "bitcoin.message" &&
    plan.format === "legacy" &&
    request.format === "legacy"
  ) {
    const bytes = new TextEncoder().encode(request.message);
    return bytes.length <= 640 && bytes.every((b) => b >= 0x20 && b <= 0x7e) ? "clear" : "blind";
  }
  return "unsupported";
};
