/**
 * `chain.sign` runs one two-pass flow for every key source — the HD EVM account of an imported
 * mnemonic and an imported EVM key must answer identically: a blind request is refused before any
 * prompt, the verification prompt gates the sign pass, the session is re-required after it, and a
 * plain message signs while blind signing stays off.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { AccountRef } from "@qntx/wallet-chains";
import { normalizeEvm } from "@qntx/wallet-chains/evm";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { RecordStore } from "../src/vault/store.ts";
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

/** A store view that holds the `reset-failures` commit until released — the post-verify window. */
const holdResetFailures = (): {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly wrap: (inner: RecordStore) => RecordStore;
} => {
  let notify: () => void = () => undefined;
  let open: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    entered,
    release: () => open(),
    wrap: (inner) => ({
      ...inner,
      commit: async (ops) => {
        if (ops.some((op) => op.op === "reset-failures")) {
          notify();
          await gate;
        }
        await inner.commit(ops);
      },
    }),
  };
};

/** A vault unlocked for the session — the source under test adds its account on top. */
const setup = async (
  h: Harness,
  factor: ProtocolValue = DEVICE,
): Promise<{ session: string; walletId: string }> => {
  await h.settle();
  const res = ok(
    // Fresh bytes every call — the kernel wipes the mnemonic once consumed.
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor }),
  );
  return { session: str(res, "session"), walletId: str(field(res, "wallet"), "walletId") };
};

type Source = {
  /** Resolves the request's account ref for this key source. */
  readonly account: (
    h: Harness,
    session: string,
    walletId: string,
  ) => AccountRef | Promise<AccountRef>;
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

const blindRequest = (account: AccountRef) =>
  normalizeEvm({
    kind: "evm.transaction",
    network: "eip155:1",
    account,
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

const textRequest = (account: AccountRef) =>
  normalizeEvm({
    kind: "evm.personal-message",
    network: "eip155:1",
    account,
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

  it("a session that ends during the post-verification commit fails locked", async () => {
    // For a password factor verifyFactor clears a nonzero failure count with a
    // `reset-failures` commit AFTER its wiped-DEK check: holding that commit leaves a real
    // await window in which the session can end. Without the post-verification
    // `session.require`, the sign pass would then open a wiped DEK and fail "integrity".
    const gate = holdResetFailures();
    const h = createHarness({ maxSessionMs: 60_000, wrapStore: gate.wrap });
    const { session, walletId } = await setup(h, {
      kind: "password",
      password: utf8ToBytes("correct horse battery staple"),
    });
    const account = await source.account(h, session, walletId);
    const wrong = await h.call(
      "chain.sign",
      {
        request: textRequest(account),
        verify: { kind: "password", password: utf8ToBytes("a wrong password") },
      },
      session,
    );
    expect(errCode(wrong)).toBe("wrong-password");
    const pending = h.call(
      "chain.sign",
      {
        request: textRequest(account),
        verify: { kind: "password", password: utf8ToBytes("correct horse battery staple") },
      },
      session,
    );
    await gate.entered;
    h.advance(60_001);
    gate.release();
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
