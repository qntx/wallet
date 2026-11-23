/**
 * Speculos smoke test — raw APDUs against the pinned Ledger apps (scripts/ledger/apps.json) running
 * in the containers started by `bun scripts/ledger/speculos.ts`. Skipped when
 * .cache/ledger/endpoints.json is absent so `vp test` without the containers stays green.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getAddress, recoverMessageAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { exchange, hasEndpoints, rapduData, rapduSw, Screen } from "./harness.ts";

type AppPin = {
  version: string;
  name: string;
};

type Pins = {
  seed: string;
  apps: Record<string, AppPin>;
};

const pins = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../scripts/ledger/apps.json", import.meta.url)),
    "utf8",
  ),
) as Pins;

const utf8 = new TextDecoder();

/** RAPDU fields are length-prefixed; a truncated response is a test failure, not undefined. */
const u8 = (d: Uint8Array, i: number): number => {
  const b = d.at(i);
  if (b === undefined) {
    throw new Error(`short RAPDU at offset ${String(i)}`);
  }
  return b;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const account = mnemonicToAccount(pins.seed);

// BIP-32 path m/44'/60'/0'/0/0, wire format: element count ‖ u32be per element.
const PATH_44_60 = Uint8Array.of(
  0x05,
  0x80,
  0x00,
  0x00,
  0x2c,
  0x80,
  0x00,
  0x00,
  0x3c,
  0x80,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

describe.skipIf(!hasEndpoints())("speculos smoke", () => {
  it.each(Object.entries(pins.apps).map(([key, app]) => ({ key, ...app })))(
    "$key reports $name $version",
    async ({ key, name: appName, version: appVersion }) => {
      // GET_APP_AND_VERSION: answered by the OS, same on every app.
      const rapdu = await exchange(key, Uint8Array.of(0xb0, 0x01, 0x00, 0x00, 0x00));
      expect(rapduSw(rapdu)).toBe(0x9000);
      const d = rapduData(rapdu);
      expect(u8(d, 0)).toBe(0x01);
      const nameLen = u8(d, 1);
      const name = utf8.decode(d.subarray(2, 2 + nameLen));
      const versionLen = u8(d, 2 + nameLen);
      const version = utf8.decode(d.subarray(3 + nameLen, 3 + nameLen + versionLen));
      expect(name).toBe(appName);
      expect(version).toBe(appVersion);
    },
  );

  it("ethereum derives the speculos seed address", async () => {
    // GET_PUBLIC_KEY, no display: E0 02 00 00, Lc = path.
    const apdu = concat(Uint8Array.of(0xe0, 0x02, 0x00, 0x00, PATH_44_60.length), PATH_44_60);
    const rapdu = await exchange("ethereum", apdu);
    expect(rapduSw(rapdu)).toBe(0x9000);
    const d = rapduData(rapdu);
    const publicKeyLen = u8(d, 0);
    expect(publicKeyLen).toBe(65);
    const addressLen = u8(d, 1 + publicKeyLen);
    const address = utf8.decode(d.subarray(2 + publicKeyLen, 2 + publicKeyLen + addressLen));
    expect(getAddress(`0x${address}`)).toBe(account.address);
  });

  const signHello = (): Uint8Array =>
    // SIGN_PERSONAL_MESSAGE, first & only chunk: E0 08 00 00, data = path ‖ u32be len ‖ "hello".
    concat(
      Uint8Array.of(0xe0, 0x08, 0x00, 0x00, 30),
      PATH_44_60,
      Uint8Array.of(0x00, 0x00, 0x00, 0x05),
      Uint8Array.of(0x68, 0x65, 0x6c, 0x6c, 0x6f),
    );

  it("ethereum signs a personal message after approval", async () => {
    const pending = exchange("ethereum", signHello());
    const screen = new Screen("ethereum");
    await screen.approve(/sign message/i);
    const rapdu = await pending;
    expect(rapduSw(rapdu)).toBe(0x9000);
    const sig = rapduData(rapdu);
    expect(sig).toHaveLength(65);
    expect(screen.texts.some((t) => t.includes("hello"))).toBe(true);
    // Response is v ‖ r ‖ s; viem's serialized signature form is r ‖ s ‖ v.
    const signature = `0x${hex(sig.subarray(1, 33))}${hex(sig.subarray(33, 65))}${u8(sig, 0)
      .toString(16)
      .padStart(2, "0")}` as `0x${string}`;
    await expect(recoverMessageAddress({ message: "hello", signature })).resolves.toBe(
      account.address,
    );
  });

  it("ethereum answers 0x6985 when the user rejects", async () => {
    const pending = exchange("ethereum", signHello());
    const screen = new Screen("ethereum");
    await screen.reject(/reject message/i);
    const rapdu = await pending;
    expect(rapduSw(rapdu)).toBe(0x6985);
  });
});
