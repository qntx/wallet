/**
 * The device-driver contract. A driver is the protocol client for one hardware device kind: it
 * turns kernel state into logical device requests (`qr`, `message`, `compare`) and parses the
 * untrusted answers. It never sees the vault — pinned public material is its only ground truth —
 * and it never touches the transport, which the host runs through `DeviceLink.exchange`.
 */
import type { KeyPath } from "@qntx/wallet-chains";
import type {
  ChainSignRequest,
  ChainTemplate,
  DeviceDisplay,
  DeviceRequest,
  DeviceResponse,
  LedgerDescriptors,
} from "@qntx/wallet/protocol";

import type { PinnedKeys } from "../../derive/pinned.ts";
import type { ChainPlan } from "../chains/run.ts";

/** The host transport: suspends until `hardware.step` answers with the device's response. */
export type DeviceLink = {
  readonly exchange: (request: DeviceRequest) => Promise<DeviceResponse>;
};

/** What a device claims to be; `fingerprint` is the BIP-32 master fingerprint. */
export type DeviceIdentity = {
  readonly fingerprint: Uint8Array;
  readonly model?: string;
  readonly firmware?: string;
};

/** Everything pairing learned: the claimed identity plus the pinned public material. */
export type PairingResult = DeviceIdentity & PinnedKeys;

/** The record's contents: the device this wallet was paired to and its pinned keys. */
export type HardwarePin = { readonly fingerprint: Uint8Array } & PinnedKeys;

/** What one stage of a device signing round needs: the request, the stage plan, the pin. */
export type SignContext = {
  readonly request: ChainSignRequest;
  readonly stage: ChainPlan;
  readonly pin: HardwarePin;
  /** The display the user was prompted with — the live device must still be able to show it. */
  readonly display: DeviceDisplay;
  /** Fresh platform randomness for request ids and challenges — never a device input. */
  readonly random: (length: number) => Uint8Array;
  /** Host-fetched clear-signing descriptors offered for this request; hostile until bound. */
  readonly descriptors?: LedgerDescriptors;
};

/**
 * The device's answer to an address check. `matched: false` is the user reporting the device shows
 * a different address — the module, not the driver, decides that means `wrong-device`.
 */
export type VerifyVerdict = {
  readonly method: "device" | "compare";
  readonly matched: boolean;
};

export type Driver = {
  /** The pairing ceremony: claims the identity and publishes the initial pinned keys. */
  readonly pair: (link: DeviceLink) => Promise<PairingResult>;
  /**
   * What the device shows for this request and plan; `unsupported` refuses before any prompt.
   * `identity` is the paired record's claimed identity — a driver whose display depends on the
   * model or firmware must refuse when the record cannot promise what the device would show.
   */
  readonly display: (
    request: ChainSignRequest,
    plan: ChainPlan,
    identity: DeviceIdentity,
    descriptors: LedgerDescriptors | undefined,
  ) => DeviceDisplay | "unsupported";
  /** Signs one plan stage: one 64-byte signature per task, in order; assemble verifies. */
  readonly sign: (link: DeviceLink, context: SignContext) => Promise<ReadonlyArray<Uint8Array>>;
  /**
   * Fetches missing public material (hardened nodes). The driver re-checks the answering device's
   * claimed identity — a device-reported fingerprint, or already-pinned material of the same family
   * re-fetched byte-for-byte — `wrong-device` on a mismatch. These comparisons only stop an
   * accidental second honest device: the checked values are public, so a foreign device or the
   * transport itself can replay them and merge its own keys. The control for that is the on-device
   * address check — merged entries stay unconfirmed until `verifyAddress` matches.
   */
  readonly accounts: (
    link: DeviceLink,
    need: {
      readonly secp256k1: ReadonlyArray<KeyPath>;
      readonly ed25519: ReadonlyArray<KeyPath>;
    },
    pin: HardwarePin,
  ) => Promise<PairingResult>;
  /**
   * Asks the user to confirm an address on the device: `device` when the device can show a
   * host-initiated display, `compare` when the user checks the device menu by hand.
   */
  readonly verifyAddress: (
    link: DeviceLink,
    target: {
      readonly path: KeyPath;
      readonly address: string;
      readonly template: ChainTemplate;
      readonly network: string;
    },
    pin: HardwarePin,
  ) => Promise<VerifyVerdict>;
};
