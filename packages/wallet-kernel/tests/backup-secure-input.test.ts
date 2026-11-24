/**
 * The backup password factor on React Native: the kernel collects it through its secure input — a
 * wire `password` arm is `unsupported` on a keystore host and the `kernel` arm is `unsupported`
 * anywhere else. Enable asks for the password and a repeat (mismatch or a short entry retries,
 * three rounds at most); restore asks once and a wrong answer surfaces as `wrong-password`.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import { fakeSecureInput } from "./secure-input.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "a backup password the kernel collects";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const KERNEL_PASSWORD = { kind: "password", ceremony: "kernel" } as const;

const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};

const errCode = (response: KernelResponse): string => {
  if ("err" in response) {
    return response.err.code;
  }
  throw new Error("expected err");
};

const field = (value: ProtocolValue, key: string): ProtocolValue => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error(`expected object, got ${typeof value}`);
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
};

const bytes = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

const sole = (value: ProtocolValue, key: string): ProtocolValue => {
  const v = field(value, key);
  if (!Array.isArray(v) || v.length !== 1) {
    throw new Error(`expected exactly one ${key}`);
  }
  return v[0] as ProtocolValue;
};

const str = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

const rnHarness = (seed: number) => {
  const keystore = fakeKeystore();
  const input = fakeSecureInput();
  const h = createHarness({
    seed,
    keystore: keystore.keystore,
    secureInput: input.secureInput,
    noIdle: true,
  });
  return { h, keystore, input };
};

const importMnemonic = async (h: Harness): Promise<string> => {
  await h.settle();
  return str(
    ok(await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE })),
    "session",
  );
};

const answer = (input: ReturnType<typeof fakeSecureInput>, text = PASSWORD): void => {
  input.answer(utf8ToBytes(text));
};

describe("the backup password on a keystore host", () => {
  it("refuses a wire password arm for enable", async () => {
    const { h } = rnHarness(1);
    const session = await importMnemonic(h);
    expect(
      errCode(
        await h.call(
          "backup.enable",
          {
            verify: HARDWARE,
            factors: [{ kind: "password", password: utf8ToBytes(PASSWORD) }],
          },
          session,
        ),
      ),
    ).toBe("unsupported");
  });

  it("refuses a wire password arm for restore", async () => {
    // A web harness produces a password-sealed envelope the RN restore is offered.
    const web = createHarness({ seed: 2 });
    await web.settle();
    const webSession = str(
      ok(
        await web.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: { kind: "password", password: utf8ToBytes("a vault password for the web") },
        }),
      ),
      "session",
    );
    ok(
      await web.call(
        "backup.enable",
        {
          verify: { kind: "password", password: utf8ToBytes("a vault password for the web") },
          factors: [{ kind: "password", password: utf8ToBytes(PASSWORD) }],
        },
        webSession,
      ),
    );
    const envelope = str(ok(await web.call("backup.update", null, webSession)), "envelope");

    const { h } = rnHarness(3);
    expect(
      errCode(
        await h.call("backup.restore", {
          envelope,
          backupFactor: { kind: "password", password: utf8ToBytes(PASSWORD) },
          factor: DEVICE,
        }),
      ),
    ).toBe("unsupported");
  });

  it("enables with two matching kernel entries and restores them on a second kernel", async () => {
    const { h: a, input: inputA } = rnHarness(4);
    const sessionA = await importMnemonic(a);
    answer(inputA);
    answer(inputA);
    ok(await a.call("backup.enable", { verify: HARDWARE, factors: [KERNEL_PASSWORD] }, sessionA));
    expect(inputA.requests).toStrictEqual([
      { kind: "backup-password", label: "Choose a cloud backup password" },
      { kind: "backup-password", label: "Enter the password again" },
    ]);
    const envelope = str(ok(await a.call("backup.update", null, sessionA)), "envelope");

    const { h: b, input: inputB } = rnHarness(5);
    answer(inputB);
    const restored = ok(
      await b.call("backup.restore", { envelope, backupFactor: KERNEL_PASSWORD, factor: DEVICE }),
    );
    expect(inputB.requests).toStrictEqual([
      { kind: "backup-password", label: "Enter the cloud backup password" },
    ]);
    const sessionB = str(restored, "session");
    const walletId = str(sole(restored, "wallets"), "walletId");
    const exported = ok(
      await b.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, sessionB),
    );
    expect(new TextDecoder().decode(bytes(exported, "mnemonic"))).toBe(MNEMONIC);
  });

  it("retries a mismatch with the mismatch title", async () => {
    const { h, input } = rnHarness(6);
    const session = await importMnemonic(h);
    answer(input, PASSWORD);
    answer(input, "a different backup password entry");
    answer(input, PASSWORD);
    answer(input, PASSWORD);
    ok(await h.call("backup.enable", { verify: HARDWARE, factors: [KERNEL_PASSWORD] }, session));
    expect(input.requests.map((r) => r.label)).toStrictEqual([
      "Choose a cloud backup password",
      "Enter the password again",
      "The passwords did not match — choose a cloud backup password",
      "Enter the password again",
    ]);
  });

  it("retries a short password with the policy title", async () => {
    const { h, input } = rnHarness(7);
    const session = await importMnemonic(h);
    answer(input, "short");
    answer(input, "short");
    answer(input, PASSWORD);
    answer(input, PASSWORD);
    ok(await h.call("backup.enable", { verify: HARDWARE, factors: [KERNEL_PASSWORD] }, session));
    expect(input.requests.map((r) => r.label)).toStrictEqual([
      "Choose a cloud backup password",
      "Enter the password again",
      "Use at least 12 characters — choose a cloud backup password",
      "Enter the password again",
    ]);
  });

  it("fails invalid-input after three unsettled rounds", async () => {
    const { h, input } = rnHarness(8);
    const session = await importMnemonic(h);
    for (let round = 0; round < 3; round++) {
      answer(input, PASSWORD);
      answer(input, `mismatched entry ${round}`);
    }
    expect(
      errCode(
        await h.call("backup.enable", { verify: HARDWARE, factors: [KERNEL_PASSWORD] }, session),
      ),
    ).toBe("invalid-input");
    expect(input.requests).toHaveLength(6);
  });

  it("maps a cancelled input to cancelled", async () => {
    const { h, input } = rnHarness(9);
    const session = await importMnemonic(h);
    input.answer("cancelled");
    expect(
      errCode(
        await h.call("backup.enable", { verify: HARDWARE, factors: [KERNEL_PASSWORD] }, session),
      ),
    ).toBe("cancelled");
  });

  it("maps an unavailable input to unavailable", async () => {
    const { h, input } = rnHarness(10);
    const session = await importMnemonic(h);
    input.answer("unavailable");
    expect(
      errCode(
        await h.call("backup.enable", { verify: HARDWARE, factors: [KERNEL_PASSWORD] }, session),
      ),
    ).toBe("unavailable");
  });

  it("answers wrong-password when the entered password does not unwrap the envelope", async () => {
    const { h: a, input: inputA } = rnHarness(11);
    const sessionA = await importMnemonic(a);
    answer(inputA);
    answer(inputA);
    ok(await a.call("backup.enable", { verify: HARDWARE, factors: [KERNEL_PASSWORD] }, sessionA));
    const envelope = str(ok(await a.call("backup.update", null, sessionA)), "envelope");

    const { h: b, input: inputB } = rnHarness(12);
    answer(inputB, "not the password the envelope was sealed under");
    expect(
      errCode(
        await b.call("backup.restore", {
          envelope,
          backupFactor: KERNEL_PASSWORD,
          factor: DEVICE,
        }),
      ),
    ).toBe("wrong-password");
  });
});

describe("the backup password off the keystore host", () => {
  it("keeps the wire password arm working on the web", async () => {
    const web = createHarness({ seed: 20 });
    await web.settle();
    const session = str(
      ok(
        await web.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: { kind: "password", password: utf8ToBytes("a vault password for the web") },
        }),
      ),
      "session",
    );
    ok(
      await web.call(
        "backup.enable",
        {
          verify: { kind: "password", password: utf8ToBytes("a vault password for the web") },
          factors: [{ kind: "password", password: utf8ToBytes(PASSWORD) }],
        },
        session,
      ),
    );
    const envelope = str(ok(await web.call("backup.update", null, session)), "envelope");
    const other = createHarness({ seed: 21 });
    await other.settle();
    const restored = ok(
      await other.call("backup.restore", {
        envelope,
        backupFactor: { kind: "password", password: utf8ToBytes(PASSWORD) },
        factor: { kind: "password", password: utf8ToBytes("another vault password here") },
      }),
    );
    expect(str(restored, "session")).not.toBe("");
  });

  it("refuses the kernel ceremony arm on the web", async () => {
    const web = createHarness({ seed: 22 });
    await web.settle();
    const session = str(
      ok(
        await web.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: { kind: "password", password: utf8ToBytes("a vault password for the web") },
        }),
      ),
      "session",
    );
    expect(
      errCode(
        await web.call(
          "backup.enable",
          {
            verify: { kind: "password", password: utf8ToBytes("a vault password for the web") },
            factors: [KERNEL_PASSWORD],
          },
          session,
        ),
      ),
    ).toBe("unsupported");
  });
});
