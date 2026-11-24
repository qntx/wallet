/**
 * The engine's Keystone helpers: the kernel test device — the single vendor-library oracle
 * (packages/wallet-kernel/tests/signers-keystone-device.ts) — behind the engine's `DeviceIo`, plus
 * `pairKeystone` pairing the shipped sync vector through the wallet/hardware coroutine. `compare`
 * (verify-address) always matches the host's answer; `hang` holds a pending exchange the way a user
 * taking time on the device would — the exchange still completes or fails as firmware would.
 */
import { readFileSync } from "node:fs";

import { hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

import type { Wallet } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import { hardware } from "@qntx/wallet/hardware";
import type { DeviceIo, DeviceRequest, DeviceResponse } from "@qntx/wallet/hardware";

import { keystoneDevice } from "../../wallet-kernel/tests/signers-keystone-device.ts";
import { MNEMONIC } from "./apps-helpers.ts";

const SEED = mnemonicToSeedSync(MNEMONIC);

/* The paired seed's master fingerprint — the check firmware runs on every request keypath. */
const FINGERPRINT = ((): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, HDKey.fromMasterSeed(SEED).fingerprint);
  return bytes;
})();

export const keystoneIo = (hang?: () => Promise<unknown>): DeviceIo => {
  const device = keystoneDevice(SEED, FINGERPRINT);
  return {
    exchange: async (request: DeviceRequest): Promise<DeviceResponse> => {
      if (request.kind === "compare") {
        return { kind: "compare", matched: true };
      }
      if (hang !== undefined) {
        await hang();
      }
      return device.respond(request);
    },
  };
};

/**
 * A `DeviceIo` over a device with its own seed — `exchange` feeds the kernel's request to the
 * oracle and counts each call (the "device asked only after approval" property is the count
 * staying zero until `submit` runs); `fail` makes the exchanges reject until cleared (a lost
 * device). Pairing through this io answers the scan with the device's own
 * `crypto-multi-accounts`.
 */
export const keystoneSimIo = (
  seed: Uint8Array,
  fingerprint: Uint8Array,
): {
  readonly io: DeviceIo;
  readonly exchanges: () => number;
  readonly fail: (error: Error | undefined) => void;
} => {
  const device = keystoneDevice(seed, fingerprint);
  let count = 0;
  let failure: Error | undefined;
  return {
    exchanges: () => count,
    fail: (error) => {
      failure = error;
    },
    io: {
      exchange: async (request) => {
        count += 1;
        if (failure !== undefined) {
          throw failure;
        }
        await Promise.resolve();
        return device.respond(request);
      },
    },
  };
};

const isSyncVector = (value: unknown): value is { sync: { cbor: string } } =>
  typeof value === "object" &&
  value !== null &&
  "sync" in value &&
  typeof value.sync === "object" &&
  value.sync !== null &&
  "cbor" in value.sync &&
  typeof value.sync.cbor === "string";

const vector: unknown = JSON.parse(
  readFileSync(new URL("../../../vectors/keystone/sync.json", import.meta.url), "utf8"),
);
if (!isSyncVector(vector)) {
  throw new Error("vectors/keystone/sync.json is not a keystone sync vector");
}
const SYNC = hexToBytes(vector.sync.cbor);

/** A DeviceIo that answers every exchange with the sync vector — pairing and stubs alike. */
export const keystoneSyncIo = (): DeviceIo => ({
  exchange: async () => {
    await Promise.resolve();
    return { kind: "qr" as const, ur: { type: "crypto-multi-accounts", cbor: SYNC } };
  },
});

/** Pairs the Keystone sync vector; an already-paired device answers its existing wallet id. */
export const pairKeystone = async (wallet: Wallet): Promise<string> => {
  try {
    const result = await hardware(wallet).start(
      { kind: "pair", device: "keystone" },
      { io: keystoneSyncIo() },
    ).result;
    if (result.kind !== "pair" || result.wallet.custody !== "hardware") {
      throw new WalletError("integrity", "pair did not return a hardware wallet");
    }
    return result.wallet.walletId;
  } catch (error) {
    if (!(error instanceof WalletError && error.code === "already-exists")) {
      throw error;
    }
    return (
      wallet.getSnapshot().wallets.find((entry) => entry.custody === "hardware")?.walletId ?? ""
    );
  }
};
