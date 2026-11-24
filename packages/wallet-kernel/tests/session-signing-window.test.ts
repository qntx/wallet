/**
 * The kernel-side bounds of `sessions.sign` for hyperliquid-l1-agent: `expiresAfter` is required
 * and at most 60 s after the wall clock, the nonce stays within ±60 s, and a signature keeps
 * covering its action after the record is deleted.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { hyperliquidL1Document } from "@qntx/wallet-chains/evm";
import type { ProtocolValue } from "@qntx/wallet/protocol";
import { ValidationError } from "@qntx/wallet/protocol";

import { hyperliquidL1Params } from "../src/modules/sessions/schemes/hyperliquid-l1-agent/params.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: utf8ToBytes("credential-1"),
  prf: new Uint8Array(32).fill(1),
});
const T0 = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86_400_000;
const SCHEME = "hyperliquid-l1-agent";
const ACTION = {
  type: "order",
  orders: [{ a: 0, b: true, p: "30000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }],
  grouping: "na",
};

const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};
const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;
const field = (value: ProtocolValue, key: string): ProtocolValue => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
};
const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};
const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

const setup = async (validUntil = T0 + 32 * DAY) => {
  const h = createHarness({ start: T0 });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: PASSKEY(),
    }),
  );
  const session = strField(res, "session");
  const walletId = strField(field(res, "wallet"), "walletId");
  const created = ok(
    await h.call(
      "sessions.create",
      {
        scheme: SCHEME,
        owner: { walletId, groupIndex: 0 },
        scope: "Mainnet",
        name: "bot-1",
        validUntil,
        limits: { notional: "1000000000", maxLeverage: 100, assets: [0, 1] },
        verify: PASSKEY(),
      },
      session,
    ),
  );
  return { h, session, address: strField(created, "address") };
};

const sign = async (
  h: Harness,
  session: string,
  address: string,
  params: Record<string, unknown>,
): Promise<KernelResponse> => h.call("sessions.sign", { scheme: SCHEME, address, params }, session);

describe("sessions.sign hyperliquid-l1-agent signing window", () => {
  it("the params validator requires expiresAfter", () => {
    // The window check would refuse a missing expiresAfter with the same code, so the wire-level
    // requirement is pinned directly — an optional-field regression is visible.
    expect(() => hyperliquidL1Params({ action: ACTION, nonce: T0 })).toThrow(ValidationError);
    expect(() =>
      hyperliquidL1Params({ action: ACTION, nonce: T0, expiresAfter: T0 + 15_000 }),
    ).not.toThrow();
  });

  it("requires expiresAfter and bounds it to (now, now + 60 s]", async () => {
    const { h, session, address } = await setup();
    expect(errCode(await sign(h, session, address, { action: ACTION, nonce: T0 }))).toBe(
      "invalid-input",
    );
    expect(
      errCode(
        await sign(h, session, address, {
          action: ACTION,
          nonce: T0,
          expiresAfter: T0 + 30 * DAY,
        }),
      ),
    ).toBe("invalid-input");
    expect(
      errCode(await sign(h, session, address, { action: ACTION, nonce: T0, expiresAfter: T0 })),
    ).toBe("invalid-input");
    expect(
      bytesField(
        ok(
          await sign(h, session, address, {
            action: ACTION,
            nonce: T0,
            expiresAfter: T0 + 1,
          }),
        ),
        "signature",
      ),
    ).toHaveLength(65);
    expect(
      bytesField(
        ok(
          await sign(h, session, address, {
            action: ACTION,
            nonce: T0,
            expiresAfter: T0 + 60_000,
          }),
        ),
        "signature",
      ),
    ).toHaveLength(65);
    expect(
      errCode(
        await sign(h, session, address, {
          action: ACTION,
          nonce: T0,
          expiresAfter: T0 + 60_001,
        }),
      ),
    ).toBe("invalid-input");
  });

  it.each([
    ["-60_000", -60_000, undefined],
    ["-60_001", -60_001, "invalid-input"],
    ["+60_000", 60_000, undefined],
    ["+60_001", 60_001, "invalid-input"],
  ])("nonce %s of now → %s", async (_label, delta, code) => {
    const { h, session, address } = await setup();
    expect(
      errCode(
        await sign(h, session, address, {
          action: ACTION,
          nonce: T0 + delta,
          expiresAfter: T0 + 15_000,
        }),
      ),
    ).toBe(code);
  });

  it("the window is measured on the platform clock — a device 23 h ahead signs its own now", async () => {
    const { h, session, address } = await setup();
    /* The documented contract: `sessions.sign` bounds `nonce` and `expiresAfter` against
       platform.now() — there is no other clock. A caller on a device running 23 h ahead of true
       time asks for the window it sees, and the kernel signs it. */
    h.advanceWall(23 * 3_600_000);
    const deviceNow = h.wallNow();
    const nonce = deviceNow;
    const expiresAfter = deviceNow + 60_000;
    const response = await sign(h, session, address, {
      action: ACTION,
      nonce,
      expiresAfter,
    });
    expect(bytesField(ok(response), "signature")).toHaveLength(65);
    expect(expiresAfter).toBe(deviceNow + 60_000);
    /* What that window spans in true time is the engine's problem (its clock cross-check), not
       this layer's — the kernel has no second source to compare against. */
    expect(expiresAfter - T0).toBe(23 * 3_600_000 + 60_000);
  });

  it("a signature keeps covering its action after the record is deleted", async () => {
    const { h, session, address } = await setup();
    const nonce = T0;
    const expiresAfter = T0 + 15_000;
    const signature = `0x${Buffer.from(
      bytesField(
        ok(await sign(h, session, address, { action: ACTION, nonce, expiresAfter })),
        "signature",
      ),
    ).toString("hex")}`;
    await h.call("sessions.delete", { address }, session);
    const doc = JSON.parse(
      hyperliquidL1Document({ action: ACTION as never, nonce, expiresAfter }, "Mainnet"),
    ) as {
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      domain: Record<string, unknown>;
      message: Record<string, unknown>;
    };
    const recovered = await recoverTypedDataAddress({
      domain: doc.domain,
      types: doc.types,
      primaryType: doc.primaryType,
      message: doc.message,
      signature,
    } as never);
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
  });
});
