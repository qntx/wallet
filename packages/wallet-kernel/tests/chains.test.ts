/**
 * Chains module `wallet.accounts` through the real protocol: import the vector mnemonic, then
 * derive each template's account and compare against vectors/templates/chains.json (BIP-84/86
 * texts, MetaMask-compatible EVM accounts, SLIP-10-checked Solana).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";
import type { KernelResponse } from "./harness.ts";

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
function strField(value: ProtocolValue, key: string): string {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`field ${key}: not a string`);
  }
  return v;
}

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/templates/chains.json"), "utf8"),
) as {
  mnemonic: string;
  master: { fingerprint: string };
  evm: {
    template: string;
    network: string;
    accounts: Array<{ groupIndex: number; address: string }>;
  };
  solana: {
    template: string;
    network: string;
    accounts: Array<{ groupIndex: number; address: string }>;
  };
  bitcoin: Array<{
    template: string;
    network: string;
    path: string;
    xpub: string;
    receive: string[];
    change: string[];
  }>;
};

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

describe("wallet.accounts", () => {
  const setup = async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    return {
      h,
      session: strField(res, "session"),
      walletId: strField(field(res, "wallet"), "walletId"),
    };
  };

  it("derives the vector EVM accounts", async () => {
    const { h, session, walletId } = await setup();
    const results = await Promise.all(
      vectors.evm.accounts.map(async ({ groupIndex }) =>
        h.call(
          "wallet.accounts",
          { walletId, groupIndex, template: vectors.evm.template, network: vectors.evm.network },
          session,
        ),
      ),
    );
    for (const [i, { address }] of vectors.evm.accounts.entries()) {
      expect(field(ok(results[i]!), "address")).toBe(address);
    }
  });

  it("derives the vector Solana accounts", async () => {
    const { h, session, walletId } = await setup();
    const results = await Promise.all(
      vectors.solana.accounts.map(async ({ groupIndex }) =>
        h.call(
          "wallet.accounts",
          {
            walletId,
            groupIndex,
            template: vectors.solana.template,
            network: vectors.solana.network,
          },
          session,
        ),
      ),
    );
    for (const [i, { address }] of vectors.solana.accounts.entries()) {
      expect(field(ok(results[i]!), "address")).toBe(address);
    }
  });

  it("derives the vector Bitcoin account xpubs and paths", async () => {
    const { h, session, walletId } = await setup();
    const results = await Promise.all(
      vectors.bitcoin.map(async (v) =>
        h.call(
          "wallet.accounts",
          { walletId, groupIndex: 0, template: v.template, network: v.network },
          session,
        ),
      ),
    );
    for (const [i, v] of vectors.bitcoin.entries()) {
      const res = ok(results[i]!);
      expect(field(res, "xpub")).toBe(v.xpub);
      expect(field(res, "fingerprint")).toBe(vectors.master.fingerprint);
      expect(field(res, "path")).toBe(v.path);
    }
  });

  it("rejects a family/network mismatch and a missing wallet", async () => {
    const { h, session, walletId } = await setup();
    const mismatch = await h.call(
      "wallet.accounts",
      {
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      },
      session,
    );
    expect("err" in mismatch).toBe(true);
    const missing = await h.call(
      "wallet.accounts",
      { walletId: "0000000000000000", groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
      session,
    );
    expect("err" in missing).toBe(true);
  });
});
