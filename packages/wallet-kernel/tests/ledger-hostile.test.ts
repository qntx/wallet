/**
 * Hostile device replies: every parser must reject malformed data with a LedgerError whose static
 * message never echoes a byte of the offending reply (checked as hex and base58).
 */

import { describe, expect, it } from "vite-plus/test";

import type { Exchange } from "../src/modules/signers/ledger/protocol/apdu.ts";
import { appAndVersion, requireApp } from "../src/modules/signers/ledger/protocol/device.ts";
import { LedgerError } from "../src/modules/signers/ledger/protocol/errors.ts";
import {
  ethAddress,
  ethSignPersonalMessage,
} from "../src/modules/signers/ledger/protocol/ethereum.ts";
import {
  solanaAddress,
  solanaSignTransaction,
} from "../src/modules/signers/ledger/protocol/solana.ts";
import {
  tronAddress,
  tronSignPersonalMessage,
} from "../src/modules/signers/ledger/protocol/tron.ts";

const PATH = [0x80_00_00_2c, 0x80_00_00_3c, 0x80_00_00_00, 0, 0];
const SOL_PATH = [0x80_00_00_2c, 0x80_00_01_f5, 0x80_00_00_00, 0x80_00_00_00];

const unhex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** An exchange that answers every command with `reply ‖ 9000` (or an explicit sw). */
const hostile =
  (reply: Uint8Array, sw = 0x9000): Exchange =>
  async (_apdu: Uint8Array) => {
    const out = new Uint8Array(reply.length + 2);
    out.set(reply);
    out[reply.length] = sw >> 8;
    out[reply.length + 1] = sw & 0xff;
    return Promise.resolve(out);
  };

const fails = async (job: Promise<unknown>, expected?: string): Promise<LedgerError> => {
  try {
    await job;
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    const e = error as LedgerError;
    if (expected !== undefined) {
      expect(e.code).toBe(expected);
    }
    return e;
  }
  throw new Error("expected LedgerError");
};

/** No error message may contain any hex or base58 substring of the device reply. */
const leakFree = (error: LedgerError, reply: Uint8Array): void => {
  const h = hex(reply);
  for (let i = 0; i + 4 <= h.length; i += 4) {
    expect(error.message).not.toContain(h.slice(i, i + 4));
  }
  // and no long run of printable reply bytes survives into the message either
  const printable = String.fromCodePoint(...reply.filter((b) => b >= 0x20 && b < 0x7f));
  for (let i = 0; i + 6 <= printable.length; i += 1) {
    const piece = printable.slice(i, i + 6);
    if (!/\s{6}/.test(piece)) {
      expect(error.message).not.toContain(piece);
    }
  }
};

const run = async (
  _label: string,
  reply: Uint8Array,
  job: (ex: Exchange) => Promise<unknown>,
  expected?: string,
): Promise<void> => {
  const error = await fails(job(hostile(reply)), expected);
  leakFree(error, reply);
};

describe("ledger hostile replies", () => {
  it("rejects malformed app-and-version replies", async () => {
    expect.hasAssertions();
    await run("bad format", unhex("02"), async (ex) => appAndVersion(ex), "invalid-response");
    await run("short name LV", unhex("010548656c"), async (ex) => appAndVersion(ex));
    await run("trailing bytes", unhex("010548656c6c6f03312e3000ff"), async (ex) =>
      appAndVersion(ex),
    );
    // non-printable name
    await run("bad name", unhex("010301020303312e30"), async (ex) => appAndVersion(ex));
    // bad version strings
    const badVersion = async (version: string): Promise<void> => {
      const v = new TextEncoder().encode(version);
      const reply = new Uint8Array(1 + 1 + 4 + 1 + v.length);
      reply.set([1, 4, 0x41, 0x70, 0x70, 0x21]); // name "App!"
      reply[6] = v.length;
      reply.set(v, 7);
      await run(`version ${version}`, reply, async (ex) => {
        const info = await appAndVersion(ex);
        requireApp(info, "ethereum");
      });
    };
    await Promise.all(["x.y.z", "1.2", "1.2.3.4", "1.2.x", ""].map(badVersion));
  });

  it("rejects malformed ethereum public key replies", async () => {
    expect.hasAssertions();
    const pub = new Uint8Array(65);
    pub[0] = 4;
    const addr = new TextEncoder().encode("Dad77910DbDFdE764fC21FCD4E74D71bBACA6D8D");
    const build = (key: Uint8Array, address: Uint8Array): Uint8Array => {
      const out = new Uint8Array(2 + key.length + address.length);
      out[0] = key.length;
      out.set(key, 1);
      out[1 + key.length] = address.length;
      out.set(address, 2 + key.length);
      return out;
    };
    // off-curve key (all zero body)
    await run("off-curve", build(pub, addr), async (ex) => ethAddress(ex, PATH, false));
    // address/key mismatch — an on-curve key whose ascii address is not its own (the recorded
    // device key with the first address character swapped) must reach the equality check
    const real = unhex(
      "04ef5b152e3f15eb0c50c9916161c2309e54bd87b9adce722d69716bcdef85f547678e15ab40a78919c7284e67a17ee9a96e8b9886b60f767d93023bac8dbc16e4",
    );
    const wrongAddr = new TextEncoder().encode("Ead77910DbDFdE764fC21FCD4E74D71bBACA6D8D");
    await run("mismatch", build(real, wrongAddr), async (ex) => ethAddress(ex, PATH, false));
    // wrong LV sizes
    await run("pk len 64", build(real.slice(1), addr), async (ex) => ethAddress(ex, PATH, false));
    await run("addr len 39", build(real, addr.slice(0, 39)), async (ex) =>
      ethAddress(ex, PATH, false),
    );
    await run("trailing", Uint8Array.from([...build(real, addr), 0xaa]), async (ex) =>
      ethAddress(ex, PATH, false),
    );
    // short signature
    await run("short sig", new Uint8Array(64), async (ex) =>
      ethSignPersonalMessage(ex, PATH, new TextEncoder().encode("x")),
    );
    await run("long sig", new Uint8Array(66), async (ex) =>
      ethSignPersonalMessage(ex, PATH, new TextEncoder().encode("x")),
    );
  });

  it("rejects malformed solana and tron replies", async () => {
    expect.hasAssertions();
    await run("sol short", new Uint8Array(31), async (ex) => solanaAddress(ex, SOL_PATH, false));
    await run("sol long", new Uint8Array(33), async (ex) => solanaAddress(ex, SOL_PATH, false));
    // ed25519 identity point is technically on-curve; use a non-decompressable encoding instead
    const badPoint = new Uint8Array(32).fill(0xff);
    await run("sol bad point", badPoint, async (ex) => solanaAddress(ex, SOL_PATH, false));
    await run("sol sig short", new Uint8Array(63), async (ex) =>
      solanaSignTransaction(ex, SOL_PATH, new Uint8Array(40)),
    );
    await run("sol sig long", new Uint8Array(65), async (ex) =>
      solanaSignTransaction(ex, SOL_PATH, new Uint8Array(40)),
    );
    await run("tron empty", new Uint8Array(0), async (ex) => tronAddress(ex, PATH, false));
    await run("tron lv", unhex("0544"), async (ex) => tronAddress(ex, PATH, false));
    const tronSig = async (ex: Exchange): Promise<unknown> =>
      tronSignPersonalMessage(ex, PATH, new TextEncoder().encode("x"));
    await run("tron sig short", new Uint8Array(64), tronSig);
    await run("tron sig long", new Uint8Array(66), tronSig);
    // pubkey LV length wrong / off-curve / address LV wrong / address mismatch
    const pub = unhex(
      "0468607df0f5bd24773280155303c61818140d8836cfbe0e34e6ed8ce7ddd14ae1ba772c18c87e9a89cbe1cdf0c6049579f025259f595e70c3160a32b515f6d9be",
    );
    const addr34 = new TextEncoder().encode("TMVkf58Mk6JiVHXFqScrFCCfy5cgMoKhN1");
    const build = (key: Uint8Array, address: Uint8Array): Uint8Array => {
      const out = new Uint8Array(2 + key.length + address.length);
      out[0] = key.length;
      out.set(key, 1);
      out[1 + key.length] = address.length;
      out.set(address, 2 + key.length);
      return out;
    };
    const badKey = new Uint8Array(65);
    badKey[0] = 4;
    await run("tron off-curve", build(badKey, addr34), async (ex) => tronAddress(ex, PATH, false));
    await run("tron addr 33", build(pub, addr34.slice(0, 33)), async (ex) =>
      tronAddress(ex, PATH, false),
    );
    const nonAscii = new Uint8Array(34).fill(0x80);
    await run("tron addr non-ascii", build(pub, nonAscii), async (ex) =>
      tronAddress(ex, PATH, false),
    );
    const wrongAddr = new TextEncoder().encode("NMVkf58Mk6JiVHXFqScrFCCfy5cgMoKhN1");
    await run("tron addr mismatch", build(pub, wrongAddr), async (ex) =>
      tronAddress(ex, PATH, false),
    );
  });

  it("unknown status words become device-fault carrying the sw", async () => {
    const ex = hostile(new Uint8Array(0), 0x9abc);
    const error = await fails(appAndVersion(ex), "device-fault");
    expect(error.sw).toBe(0x9abc);
    leakFree(error, unhex("9abc"));
    // and even a known-word-looking unknown on this app stays device-fault
    const ex2 = hostile(new Uint8Array(0), 0x6a80);
    const error2 = await fails(appAndVersion(ex2), "device-fault");
    expect(error2.sw).toBe(0x6a80);
  });
});
