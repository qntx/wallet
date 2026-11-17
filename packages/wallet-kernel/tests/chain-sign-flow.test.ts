/**
 * `chain.sign` runs one two-pass flow for every key source — the HD EVM account of an imported
 * mnemonic and an imported EVM key must answer identically: a blind request is refused before any
 * prompt, the verification prompt gates the sign pass, the session is re-required after it, and a
 * plain message signs while blind signing stays off.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { normalizeEvm } from "@qntx/wallet-chains/evm";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
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

const opens = (calls: ReadonlyArray<KeystoreCall>) =>
  calls.flatMap((call) => (call.op === "open" && call.prompt !== undefined ? [call.prompt] : []));

/** A vault unlocked for the session — the source under test adds its account on top. */
const setup = async (h: Harness): Promise<{ session: string; walletId: string }> => {
  await h.settle();
  const res = ok(
    // Fresh bytes every call — the kernel wipes the mnemonic once consumed.
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  return { session: str(res, "session"), walletId: str(field(res, "wallet"), "walletId") };
};

type Source = {
  /** Resolves the request's account ref for this key source. */
  readonly account: (
    h: Harness,
    session: string,
    walletId: string,
  ) => ProtocolValue | Promise<ProtocolValue>;
};

const sources: ReadonlyArray<readonly [string, Source]> = [
  [
    "hd",
    {
      account: (_h, _session, walletId) => ({
        kind: "hd",
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
      }),
    },
  ],
  [
    "imported",
    {
      account: async (h, session) => {
        // Fresh bytes — the kernel wipes the secret once the record is sealed.
        const res = ok(
          await h.call(
            "keys.import",
            { family: "evm", secret: new Uint8Array(32).fill(0x11) },
            session,
          ),
        );
        return { kind: "imported", keyId: str(res, "keyId"), family: "evm" };
      },
    },
  ],
];

const blindRequest = (account: ProtocolValue) =>
  normalizeEvm({
    kind: "evm.transaction",
    network: "eip155:1",
    account: account as never,
    tx: {
      type: "eip1559",
      chainId: 1,
      nonce: 0,
      gas: "0x5208",
      value: "0x1",
      data: "0xdeadbeef",
      to: "0x00000000000000000000000000000000deadbeef",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x1",
      accessList: [],
    },
  });

const textRequest = (account: ProtocolValue) =>
  normalizeEvm({
    kind: "evm.personal-message",
    network: "eip155:1",
    account: account as never,
    message: utf8ToBytes("hello"),
  });

describe.each(sources)("chain.sign two-pass flow: %s", (_name, source) => {
  it("refuses a blind request before any prompt while blind signing is off", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await setup(h);
    const account = await source.account(h, session, walletId);
    const opened = opens(fake.calls).length;
    const response = await h.call(
      "chain.sign",
      { request: blindRequest(account), verify: HARDWARE },
      session,
    );
    expect(errCode(response)).toBe("blind-signing-disabled");
    expect("ok" in response).toBe(false);
    expect(opens(fake.calls)).toHaveLength(opened);
  });

  it("signs the blind request once blind signing is enabled", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await setup(h);
    const account = await source.account(h, session, walletId);
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session));
    const response = await h.call(
      "chain.sign",
      { request: blindRequest(account), verify: HARDWARE },
      session,
    );
    expect(errCode(response)).toBeUndefined();
    expect("ok" in response).toBe(true);
  });

  it("a session that ends during the prompt fails locked without signing", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore, maxSessionMs: 60_000 });
    const { session, walletId } = await setup(h);
    const account = await source.account(h, session, walletId);
    const release = fake.hold();
    const prompted = new Promise<void>((resolve) => {
      fake.watchOpen(resolve);
    });
    const pending = h.call(
      "chain.sign",
      { request: textRequest(account), verify: HARDWARE },
      session,
    );
    await prompted;
    h.advance(60_001);
    release();
    const response = await pending;
    expect(errCode(response)).toBe("locked");
    expect("ok" in response).toBe(false);
    expect(field(ok(await h.call("status")), "vault")).toBe("locked");
  });

  it("a text personal message signs while blind signing is off", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await setup(h);
    const account = await source.account(h, session, walletId);
    const response = await h.call(
      "chain.sign",
      { request: textRequest(account), verify: HARDWARE },
      session,
    );
    expect(errCode(response)).toBeUndefined();
    expect("ok" in response).toBe(true);
  });
});
