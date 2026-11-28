/**
 * `chain.sign` runs one two-pass flow for every key source — the HD EVM account of an imported
 * mnemonic and an imported EVM key must answer identically: a blind request is refused before any
 * prompt, the verification prompt gates the sign pass, the session is re-required after it, and a
 * plain message signs while blind signing stays off.
 */
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { AccountRef } from "@qntx/wallet-chains";
import { normalizeEvm, recoverEvmSigner } from "@qntx/wallet-chains/evm";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { VaultAnchor } from "../src/platform.ts";
import { decodeAnchor } from "../src/vault/anchor.ts";
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

/** An anchor view that holds the counter-clearing CAS until released — the post-verify window. */
const holdCounterClear = (): {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly wrap: (inner: VaultAnchor) => VaultAnchor;
} => {
  let notify: () => void = () => undefined;
  let open: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const clears = (next: Uint8Array, expected: Uint8Array | undefined): boolean =>
    expected !== undefined &&
    decodeAnchor(expected).failedAttempts !== 0 &&
    decodeAnchor(next).failedAttempts === 0;
  return {
    entered,
    release: () => open(),
    wrap: (inner) => ({
      ...inner,
      replace: async (next, expected) => {
        if (clears(next, expected)) {
          notify();
          await gate;
        }
        return inner.replace(next, expected);
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

/* Opaque bytes the decoder cannot show: blind "message-bytes". */
const blindRequest = (account: AccountRef) =>
  normalizeEvm({
    kind: "evm.personal-message",
    network: "eip155:1",
    account,
    message: new Uint8Array(32).fill(0xff),
  });

/* An unknown function of an unlisted contract: the wallet describes it but cannot verify it. */
const describedRequest = (account: AccountRef) =>
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
    expect(field(ok(await h.call("status")), "vault")).toStrictEqual({ status: "locked" });
  });

  it("a session that ends during the post-verification write fails locked", async () => {
    // For a password factor verifyFactor clears a nonzero failure count with an anchor CAS
    // AFTER its wiped-DEK check: holding that write leaves a real await window in which the
    // session can end. Without the post-verification `session.require`, the sign pass would
    // then open a wiped DEK and fail "integrity".
    const gate = holdCounterClear();
    const h = createHarness({ maxSessionMs: 60_000, wrapAnchor: gate.wrap });
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
    expect(field(ok(await h.call("status")), "vault")).toStrictEqual({ status: "locked" });
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

  it("a described contract call signs while blind signing is off", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await setup(h);
    const account = await source.account(h, session, walletId);
    const response = await h.call(
      "chain.sign",
      { request: describedRequest(account), verify: HARDWARE },
      session,
    );
    expect(errCode(response)).toBeUndefined();
    expect(opens(fake.calls).at(-1)).toStrictEqual({
      title: "Confirm contract call",
      description: `The wallet cannot verify what this call does\nNetwork: Ethereum\nCall contract 0x00000000000000000000000000000000DeaDBeef, function 0xdeadbeef\nSend 0.000000000000000001 ETH to 0x00000000000000000000000000000000DeaDBeef\nMax fee 0.0000315 ETH`,
    });
  });
});

const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

/* The Fiat24 session grant — vectors/api/session.json in @qntx/fiat24 (cast-generated, anvil
   key 0): tokenId 123456, deadline 1795278000, the label/digest/message scheme of SPEC §9.2. */
const FIAT24_ANVIL_KEY = hexToBytes(
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const FIAT24_ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FIAT24_DEADLINE = 1795278000;
const FIAT24_MESSAGE =
  "I agree to access my profile. 0x88f9ba6123137a551cdcf75f832f04b49b808ca993a625ecde45be54094e9cbd";
const FIAT24_SIGNATURE =
  "1fed1f861a97bc875df8aa61b79dd054a614d0934b42a5750b8b873410afee1625cf19bb748e61fabef563fda4711dd9f92f84ae7275e6fdb1258bdca6c876c81c";

const fiat24Request = (account: AccountRef) =>
  normalizeEvm({
    kind: "evm.fiat24-session",
    network: "eip155:42161",
    account,
    tokenId: "123456",
    deadline: FIAT24_DEADLINE,
  });

/** A vault with the anvil key imported as an EVM key; `left` seconds remain at the wall clock. */
const fiat24Setup = async (h: Harness): Promise<{ session: string; account: AccountRef }> => {
  const { session } = await setup(h);
  const res = ok(
    await h.call(
      "keys.import",
      { family: "evm", secret: Uint8Array.from(FIAT24_ANVIL_KEY) },
      session,
    ),
  );
  return {
    session,
    account: { kind: "imported", keyId: str(res, "keyId"), family: "evm" },
  };
};

describe("chain.sign evm.fiat24-session", () => {
  it("signs the grant message and shows the session prompt", async () => {
    const fake = fakeKeystore();
    const h = createHarness({
      keystore: fake.keystore,
      start: (FIAT24_DEADLINE - 600) * 1000,
    });
    const { session, account } = await fiat24Setup(h);
    const request = fiat24Request(account);
    const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
    expect(errCode(response)).toBeUndefined();
    const res = ok(response);
    expect(str(res, "kind")).toBe("evm.fiat24-session");
    const signature = bytesField(res, "signature");
    expect(Buffer.from(signature).toString("hex")).toBe(FIAT24_SIGNATURE);
    expect(recoverEvmSigner(request, { signature })).toBe(FIAT24_ANVIL_ADDRESS.toLowerCase());
    expect(opens(fake.calls).at(-1)).toStrictEqual({
      title: "Allow Fiat24 account access",
      description:
        "A bearer grant for the Fiat24 account of the signing address, " +
        "valid until 2026-11-21 16:20 (UTC)\n" +
        "Until then, the holder can read your Fiat24 profile, contact data and card details, " +
        "and create or change cards, payees and your email — " +
        "the card one-time-password channel\n" +
        `Signs: ${FIAT24_MESSAGE}`,
    });
  });

  it.each([
    { left: 1, code: undefined },
    { left: 1200, code: undefined },
    { left: 0, code: "invalid-input" },
    { left: 1201, code: "invalid-input" },
    { left: -5, code: "invalid-input" },
  ])("deadline window edge left=$left -> $code", async ({ left, code }) => {
    const h = createHarness({
      keystore: fakeKeystore().keystore,
      start: (FIAT24_DEADLINE - left) * 1000,
    });
    const { session, account } = await fiat24Setup(h);
    const response = await h.call(
      "chain.sign",
      { request: fiat24Request(account), verify: HARDWARE },
      session,
    );
    expect(errCode(response)).toBe(code);
  });

  it("refuses on the sign pass when the prompt outlived the window", async () => {
    const fake = fakeKeystore();
    const h = createHarness({
      keystore: fake.keystore,
      start: (FIAT24_DEADLINE - 600) * 1000,
    });
    const { session, account } = await fiat24Setup(h);
    const release = fake.hold();
    const prompted = new Promise<void>((resolve) => {
      fake.watchOpen(resolve);
    });
    const pending = h.call(
      "chain.sign",
      { request: fiat24Request(account), verify: HARDWARE },
      session,
    );
    await prompted;
    h.advanceWall(600_001);
    release();
    const response = await pending;
    expect(errCode(response)).toBe("invalid-input");
    expect("ok" in response).toBe(false);
  });

  const RAW_GRANTS = [
    "I agree to access my profile. 0xfa48d2c6c46ff6b326dbd0a56c06b06795d7b2e3e58fed6b9d367e2917065f82",
    "I agree to access my Fiat24 profile. 0xfa48d2c6c46ff6b326dbd0a56c06b06795d7b2e3e58fed6b9d367e2917065f82",
  ];

  it.each(RAW_GRANTS)(
    "a raw grant text is refused until blind signing is enabled: %s",
    async (text) => {
      const fake = fakeKeystore();
      const h = createHarness({ keystore: fake.keystore });
      const { session, account } = await fiat24Setup(h);
      const request = normalizeEvm({
        kind: "evm.personal-message",
        network: "eip155:42161",
        account,
        message: utf8ToBytes(text),
      });
      const refused = await h.call("chain.sign", { request, verify: HARDWARE }, session);
      expect(errCode(refused)).toBe("blind-signing-disabled");
      ok(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session));
      const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
      expect(errCode(response)).toBeUndefined();
      const prompt = opens(fake.calls).at(-1);
      expect(prompt?.title).toBe("Confirm blind signing");
      expect(prompt?.description).toContain(
        "This is a Fiat24 account access grant: until it expires, anyone holding the signature " +
          "can read your profile and card details and change cards, payees and your email. " +
          "The wallet signs Fiat24 grants only when it builds them itself.",
      );
      expect(prompt?.description).toContain(text);
    },
  );

  it.each([
    ["a trailing CRLF", `${RAW_GRANTS[0]}\r\n`, [RAW_GRANTS[0]]],
    [
      /* The hazard line pushes this prompt over the platform bound, so the grant text itself
         is withheld and the count line takes its place. */
      "a trailing bidi override",
      `${RAW_GRANTS[0]}\u202E`,
      ["This text contains hidden or reordering characters", "… 1 more lines not shown"],
    ],
  ] as const)(
    "a raw grant with %s is refused until blind signing is enabled",
    async (_name, text, shown) => {
      const fake = fakeKeystore();
      const h = createHarness({ keystore: fake.keystore });
      const { session, account } = await fiat24Setup(h);
      const request = normalizeEvm({
        kind: "evm.personal-message",
        network: "eip155:42161",
        account,
        message: utf8ToBytes(text),
      });
      const refused = await h.call("chain.sign", { request, verify: HARDWARE }, session);
      expect(errCode(refused)).toBe("blind-signing-disabled");
      ok(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session));
      const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
      expect(errCode(response)).toBeUndefined();
      const prompt = opens(fake.calls).at(-1);
      expect(prompt?.title).toBe("Confirm blind signing");
      expect(prompt?.description).toContain("This is a Fiat24 account access grant:");
      for (const line of shown) {
        expect(prompt?.description).toContain(line);
      }
    },
  );
});
