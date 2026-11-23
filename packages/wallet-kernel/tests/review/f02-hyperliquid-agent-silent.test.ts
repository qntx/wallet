/**
 * F-02 Hyperliquid agent signs value-moving orders with no user presence.
 *
 * A `hyperliquid-l1-agent` session key, once created, signs orders and leverage changes purely from
 * sealed state: a relaunched kernel reopens the vault through the device factor (silent — no
 * keystore prompt, no presence check) and `sessions.sign` completes for a spot sell priced at 1e-8
 * and for 1000x leverage. Across the whole relaunch+sign window the platform keystore records only
 * device-protection opens/seals and no `authenticate` call.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createMemoryStore } from "../../src/vault/memory.ts";
import { createHarness } from "../harness.ts";
import type { KernelResponse } from "../harness.ts";
import { fakeKeystore } from "../keystore.ts";
import type { KeystoreCall } from "../keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const SCHEME = "hyperliquid-l1-agent";
const T0 = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86_400_000;

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}

const str = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

/* No user-facing keystore work: `authenticate` never runs and no `open`/`seal` carries a
 * presence prompt. A `probe` with protection "presence" is allowed — it is a passive
 * existence check on the hardware key and cannot reach the user. */
const onlyDeviceCalls = (calls: ReadonlyArray<KeystoreCall>): void => {
  for (const call of calls) {
    expect(call.op).not.toBe("authenticate");
    if ("prompt" in call) {
      expect(call.prompt).toBeUndefined();
    }
    if ("protection" in call && call.op !== "probe") {
      expect(call.protection).toBe("device");
    }
  }
};

describe("F-02 Hyperliquid agent signs value-moving orders with no user presence", () => {
  it("a relaunch reopens the vault silently and signs a spot sell at 1e-8 …and sets 1000x leverage", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();

    // First launch: import under the device factor and enrol a 30-day agent session key.
    const h1 = createHarness({ keystore: fake.keystore, store, start: T0 });
    await h1.settle();
    const imported = ok(
      await h1.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
    );
    const session1 = str(imported, "session");
    const walletId = str(field(imported, "wallet"), "walletId");
    const created = ok(
      await h1.call(
        "sessions.create",
        {
          scheme: SCHEME,
          owner: { walletId, groupIndex: 0 },
          scope: "Mainnet",
          name: "bot-1",
          validUntil: T0 + 30 * DAY,
        },
        session1,
      ),
    );
    const address = str(created, "address");

    // Relaunch on the same store + keystore: the device factor reopens the vault silently.
    const h2 = createHarness({ keystore: fake.keystore, store, start: T0 + 5000 });
    await h2.settle();
    const callsAtRelaunch = fake.calls.length;
    const session2 = str(ok(await h2.call("vault.unlock", { factor: DEVICE })), "session");

    const nonce = h2.wallNow();
    const signed = ok(
      await h2.call(
        "sessions.sign",
        {
          scheme: SCHEME,
          address,
          params: {
            action: {
              type: "order",
              orders: [
                {
                  a: 10107,
                  b: false,
                  p: "0.00000001",
                  s: "99999",
                  r: false,
                  t: { limit: { tif: "Ioc" } },
                },
              ],
              grouping: "na",
            },
            nonce,
            expiresAfter: nonce + 30_000,
          },
        },
        session2,
      ),
    );
    expect(field(signed, "signature")).toBeDefined();

    const nonce2 = h2.wallNow();
    const leveraged = ok(
      await h2.call(
        "sessions.sign",
        {
          scheme: SCHEME,
          address,
          params: {
            action: { type: "updateLeverage", asset: 0, isCross: false, leverage: 1000 },
            nonce: nonce2,
            expiresAfter: nonce2 + 30_000,
          },
        },
        session2,
      ),
    );
    expect(field(leveraged, "signature")).toBeDefined();

    // Every keystore use since the relaunch was device-protected; nothing asked for presence.
    onlyDeviceCalls(fake.calls.slice(callsAtRelaunch));
  });
});
