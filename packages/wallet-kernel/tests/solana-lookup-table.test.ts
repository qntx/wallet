/**
 * A Solana recipient resolved through caller-supplied lookup-table contents is unverifiable: the
 * signature binds only the compiled message bytes, so the same bytes can be presented as paying any
 * address the caller's table declares. The intent must be blind and must not name the
 * table-resolved address.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { LEDGER_DRIVER } from "../src/modules/signers/ledger/driver.ts";
import { ONEKEY_DRIVER } from "../src/modules/signers/onekey/driver.ts";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";
import { loadTranscript, replayExchange, transcriptSession } from "./onekey-emulator/index.ts";
import { fakeDevice, masterFingerprint } from "./signers-fake.ts";
import {
  caseSteps,
  hex,
  ok as okHex,
  scriptedLedger,
  SEED as LEDGER_SEED,
  unhex,
  utf8Hex,
  vectorCase,
  xpubAt,
} from "./signers-ledger-fake.ts";
import {
  LOOKUP_OTHER,
  LOOKUP_RECIPIENT,
  LOOKUP_TABLE,
  lookupTransferRequest,
  SOLANA_NETWORK,
} from "./solana-lookup-fixture.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const NETWORK = SOLANA_NETWORK;

const TABLE = LOOKUP_TABLE;
const ALICE = LOOKUP_RECIPIENT;
const MALLORY = LOOKUP_OTHER;

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

const bytes = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;

const openDescriptions = (calls: ReadonlyArray<KeystoreCall>): string[] =>
  calls.flatMap((call) =>
    call.op === "open" && call.prompt !== undefined ? [call.prompt.description] : [],
  );

const setup = async (h: Harness, fake: ReturnType<typeof fakeKeystore>) => {
  void fake;
  await h.settle();
  const imported = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  const session = str(imported, "session");
  const walletId = str(field(imported, "wallet"), "walletId");
  const account = {
    kind: "hd" as const,
    walletId,
    groupIndex: 0,
    template: "solana.bip44-change" as const,
  };
  const own = str(
    ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "solana.bip44-change", network: NETWORK },
        session,
      ),
    ),
    "address",
  );
  const request = (recipient: string) => lookupTransferRequest(account, own, recipient);
  return { session, request };
};

describe("a Solana named account resolved through a caller-supplied lookup table", () => {
  it("is refused before any keystore call while blind signing is off", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, request } = await setup(h, fake);
    const callsBefore = fake.calls.length;
    expect(
      errCode(await h.call("chain.sign", { request: request(ALICE), verify: HARDWARE }, session)),
    ).toBe("blind-signing-disabled");
    expect(
      errCode(await h.call("chain.sign", { request: request(MALLORY), verify: HARDWARE }, session)),
    ).toBe("blind-signing-disabled");
    expect(fake.calls.slice(callsBefore)).toStrictEqual([]);
  });

  it("prompts the lookup-table warning and never names a table-resolved recipient", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, request } = await setup(h, fake);
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session));

    const sign = async (recipient: string) => {
      const before = fake.calls.length;
      const res = ok(
        await h.call("chain.sign", { request: request(recipient), verify: HARDWARE }, session),
      );
      return { res, prompts: openDescriptions(fake.calls.slice(before)) };
    };
    const alice = await sign(ALICE);
    const mallory = await sign(MALLORY);

    const aliceText = alice.prompts.join("\n");
    const malloryText = mallory.prompts.join("\n");
    expect(alice.prompts.length).toBeGreaterThan(0);
    expect(aliceText).toContain("address lookup table");
    expect(malloryText).toContain("address lookup table");
    expect(aliceText).not.toContain(ALICE);
    expect(aliceText).not.toContain(MALLORY);
    expect(malloryText).not.toContain(ALICE);
    expect(malloryText).not.toContain(MALLORY);

    /* Same message bytes, same signature — which is exactly why the recipient is unverifiable. */
    expect(bytes(alice.res, "signature")).toStrictEqual(bytes(mallory.res, "signature"));
  });
});

/** Answers each `exchange` step of a begun op through `answer` until `done` — its result. */
const pumpDeviceOp = async (
  h: Harness,
  session: string,
  begin: ProtocolValue,
  answer: (request: ProtocolValue) => Promise<ProtocolValue>,
): Promise<ProtocolValue> => {
  const opId = str(begin, "opId");
  let step = field(begin, "step");
  for (let guard = 0; str(step, "kind") === "exchange" && guard < 64; guard += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one device turn per step
    const response = await answer(field(step, "request"));
    // oxlint-disable-next-line no-await-in-loop -- one device turn per step
    const next = await h.call("hardware.step", { opId, response }, session);
    if ("err" in next) {
      throw new Error(`hardware.step failed: ${JSON.stringify(next.err)}`);
    }
    step = next.ok;
  }
  if (str(step, "kind") !== "done") {
    throw new Error(`the operation did not finish: ${JSON.stringify(step)}`);
  }
  return field(step, "result");
};

/**
 * A keystore host with a scripted Ledger and a transcript OneKey paired: the Ledger pairs on its
 * Bitcoin app (the only one that reveals the fingerprint) and then trust-fetches its group-0
 * solana leaf; the OneKey transcript pins the leaf in pair. Both wallets can serve group-0 solana.
 */
const bootDevices = async () => {
  const H4 = 0x80000000;
  const fake = fakeKeystore();
  const h = createHarness({
    keystore: fake.keystore,
    drivers: {
      keystone: fakeDevice(LEDGER_SEED).driver,
      ledger: LEDGER_DRIVER,
      onekey: ONEKEY_DRIVER,
    },
  });
  await h.settle();
  const imported = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  const session = str(imported, "session");

  const pairLink = scriptedLedger("bitcoin", [
    { response: okHex(hex(masterFingerprint(LEDGER_SEED))) },
    ...[44, 49, 84, 86].map((purpose) => ({
      response: okHex(utf8Hex(xpubAt([purpose + H4, H4, H4]))),
    })),
  ]);
  const ledgerPair = ok(
    await h.call("hardware.begin", { op: { kind: "pair", device: "ledger" } }, session),
  );
  const ledgerResult = await pumpDeviceOp(h, session, ledgerPair, pairLink.link.exchange);
  pairLink.done();
  const ledgerId = str(field(ledgerResult, "wallet"), "walletId");

  const solLink = scriptedLedger("solana", caseSteps("solana", "address"));
  const ledgerAccounts = ok(
    await h.call(
      "hardware.begin",
      {
        op: {
          kind: "accounts",
          walletId: ledgerId,
          groupIndex: 0,
          templates: ["solana.bip44-change"],
          network: NETWORK,
        },
      },
      session,
    ),
  );
  await pumpDeviceOp(h, session, ledgerAccounts, solLink.link.exchange);
  solLink.done();

  const onekey = replayExchange(transcriptSession(loadTranscript("pro", "driver"), "driver-pair"));
  const onekeyPair = ok(
    await h.call("hardware.begin", { op: { kind: "pair", device: "onekey" } }, session),
  );
  const onekeyResult = await pumpDeviceOp(h, session, onekeyPair, async (request) => ({
    kind: "message",
    data: await onekey(bytes(request, "data")),
  }));
  const onekeyId = str(field(onekeyResult, "wallet"), "walletId");

  const own = async (walletId: string): Promise<string> =>
    str(
      ok(
        await h.call(
          "wallet.accounts",
          { walletId, groupIndex: 0, template: "solana.bip44-change", network: NETWORK },
          session,
        ),
      ),
      "address",
    );
  return { fake, h, session, ledgerId, onekeyId, ledgerOwn: await own(ledgerId), onekeyOwn: await own(onekeyId) };
};

describe("a lookup-table sign on a paired device", () => {
  it("hardware.begin refuses ledger and onekey signs before any device exchange while off", async () => {
    const { fake, h, session, ledgerId, onekeyId, ledgerOwn, onekeyOwn } = await bootDevices();
    const keystoreCalls = fake.calls.length;
    for (const [walletId, signer] of [
      [ledgerId, ledgerOwn],
      [onekeyId, onekeyOwn],
    ] as const) {
      const request = lookupTransferRequest(
        { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
        signer,
        ALICE,
      );
      /* A refused begin answers an error — never an exchange step — so the device sees no
         bytes; the refusal also precedes the presence ceremony. */
      expect(
        errCode(
          await h.call(
            "hardware.begin",
            { op: { kind: "sign", request }, verify: HARDWARE },
            session,
          ),
        ),
      ).toBe("blind-signing-disabled");
      expect(fake.calls).toHaveLength(keystoreCalls);
    }
  });

  it("the exchange step displays blind and the verify prompt carries the blind device line", async () => {
    const { fake, h, session, ledgerId, onekeyId, ledgerOwn, onekeyOwn } = await bootDevices();
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session));
    for (const [walletId, signer, device] of [
      [ledgerId, ledgerOwn, "Ledger"],
      [onekeyId, onekeyOwn, "OneKey"],
    ] as const) {
      const before = fake.calls.length;
      const request = lookupTransferRequest(
        { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
        signer,
        MALLORY,
      );
      const begin = ok(
        await h.call("hardware.begin", { op: { kind: "sign", request }, verify: HARDWARE }, session),
      );
      const step = field(begin, "step");
      expect(str(step, "kind")).toBe("exchange");
      expect(str(step, "display")).toBe("blind");
      const text = openDescriptions(fake.calls.slice(before)).join("\n");
      expect(text).toContain(
        `${device}: the device cannot show this request in full — signing is blind`,
      );
      ok(await h.call("hardware.cancel", { opId: str(begin, "opId") }, session));
    }
  });
});
