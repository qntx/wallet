/**
 * A Solana recipient resolved through caller-supplied lookup-table contents is unverifiable: the
 * signature binds only the compiled message bytes, so the same bytes can be presented as paying
 * any address the caller's table declares. The intent must be blind and must not name the
 * table-resolved address.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { normalizeSolana } from "@qntx/wallet-chains/solana";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const TABLE = base58.encode(new Uint8Array(32).fill(0x07));
const ALICE = base58.encode(new Uint8Array(32).fill(0xa1));
const MALLORY = base58.encode(new Uint8Array(32).fill(0xb2));

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
  "err" in response ? (response.err.code as string) : undefined;

const openDescriptions = (calls: ReadonlyArray<KeystoreCall>): string[] =>
  calls.flatMap((call) =>
    call.op === "open" && call.prompt !== undefined ? [call.prompt.description] : [],
  );

/** A v0 transfer of 1 SOL: fee payer index 0 → `to` = lookup table 0, writable index 0. */
const altTransferMessage = (feePayer: Uint8Array): Uint8Array => {
  const system = new Uint8Array(32); // system program = the zero address
  const blockhash = new Uint8Array(32).fill(0x33);
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // system transfer
  dv.setBigUint64(4, 1_000_000_000n, true);
  return new Uint8Array([
    0x80, // version 0
    1,
    0,
    1, // 1 signer, 0 readonly signers, 1 readonly unsigned (system)
    2,
    ...feePayer,
    ...system,
    ...blockhash,
    1, // 1 instruction
    1, // programAddressIndex = system (static index 1)
    2,
    0,
    2, // accountIndices [0 (from), 2 (to = loaded writable #0)]
    12,
    ...data,
    1, // 1 addressTableLookup
    ...base58.decode(TABLE),
    1,
    0, // 1 writable index: table[0]
    0, // 0 readonly indexes
  ]);
};

const setup = async (h: Harness, fake: ReturnType<typeof fakeKeystore>) => {
  void fake;
  await h.settle();
  const imported = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  const session = str(imported, "session");
  const walletId = str(field(imported, "wallet"), "walletId");
  const account = { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" };
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
  const message = altTransferMessage(base58.decode(own));
  const request = (recipient: string) =>
    normalizeSolana(
      {
        kind: "solana.transaction",
        network: NETWORK,
        account,
        message,
        lookupTables: [{ address: TABLE, addresses: [recipient] }],
      },
      own,
    );
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
