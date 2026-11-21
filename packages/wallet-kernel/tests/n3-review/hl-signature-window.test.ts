/**
 * The kernel-side bounds of `hyperliquid.signL1`: the nonce window around wall time and the fact
 * that a signature stays valid for what it covered even after the local agent record is deleted.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { l1ConnectionId, phantomAgentTypedData } from "../../src/modules/apps/l1.ts";
import type { KernelResponse, Harness } from "../harness.ts";
import { createHarness } from "../harness.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: utf8ToBytes("credential-1"),
  prf: new Uint8Array(32).fill(1),
});
const T0 = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86_400_000;
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
const strField = (value: ProtocolValue, key: string): string => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
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
const objField = (value: ProtocolValue, key: string): ProtocolValue => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`${key} missing`);
  }
  return v;
};

const setup = async () => {
  const h = createHarness({ start: T0 });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: PASSKEY() }),
  );
  return {
    h,
    session: strField(res, "session"),
    walletId: strField(objField(res, "wallet"), "walletId"),
  };
};

const createAgent = async (h: Harness, session: string, walletId: string): Promise<string> =>
  strField(
    ok(
      await h.call(
        "hyperliquid.createAgent",
        {
          owner: { walletId, groupIndex: 0 },
          network: "Mainnet",
          name: "bot-1",
          validUntil: T0 + 32 * DAY,
        },
        session,
      ),
    ),
    "address",
  );

const sign = async (h: Harness, session: string, agent: string, params: Record<string, unknown>) =>
  h.call("hyperliquid.signL1", { agent, action: ACTION, ...params }, session);

describe("hyperliquid.signL1 signing window", () => {
  it("signs without expiresAfter when the nonce is wall time", async () => {
    const { h, session, walletId } = await setup();
    const agent = await createAgent(h, session, walletId);
    const signed = ok(await sign(h, session, agent, { nonce: T0 }));
    expect(bytesField(signed, "signature")).toHaveLength(65);
  });

  it("signs with expiresAfter 30 days out", async () => {
    const { h, session, walletId } = await setup();
    const agent = await createAgent(h, session, walletId);
    const signed = ok(await sign(h, session, agent, { nonce: T0, expiresAfter: T0 + 30 * DAY }));
    expect(bytesField(signed, "signature")).toHaveLength(65);
  });

  it("accepts a nonce 299999 ms back and refuses one 300001 ms back", async () => {
    const { h, session, walletId } = await setup();
    const agent = await createAgent(h, session, walletId);
    expect(
      bytesField(ok(await sign(h, session, agent, { nonce: T0 - 299_999 })), "signature"),
    ).toHaveLength(65);
    expect(errCode(await sign(h, session, agent, { nonce: T0 - 300_001 }))).toBe("invalid-input");
  });

  it("a signature keeps covering its action after the agent record is deleted", async () => {
    const { h, session, walletId } = await setup();
    const agent = await createAgent(h, session, walletId);
    const nonce = T0;
    const signature = `0x${Buffer.from(
      bytesField(ok(await sign(h, session, agent, { nonce })), "signature"),
    ).toString("hex")}`;
    await h.call("hyperliquid.deleteAgent", { address: agent }, session);
    const doc = JSON.parse(
      phantomAgentTypedData(l1ConnectionId({ action: ACTION as never, nonce }), "Mainnet"),
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
    expect(recovered.toLowerCase()).toBe(agent.toLowerCase());
  });
});
