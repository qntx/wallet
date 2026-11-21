/**
 * Every built-in EVM network signs through the real `chain.sign` flow: the kernel derives the
 * account, binds the request's chainId to its network id and produces an envelope viem parses and
 * recovers — the signer is the vector mnemonic's first account and the prompt names the network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { utf8ToBytes } from "@noble/hashes/utils.js";
import { bytesToHex, parseTransaction, recoverTransactionAddress } from "viem";
import type { TransactionSerialized } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { normalizeEvm } from "@qntx/wallet-chains/evm";
import { BUILT_IN_NETWORKS } from "@qntx/wallet-chains/networks";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { KeystorePrompt } from "../src/platform.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/evm.json"), "utf8"),
) as {
  mnemonic: string;
  addresses: string[];
};

const EVM_NETWORKS = BUILT_IN_NETWORKS.filter((n) => n.family === "evm");

/** The vector mnemonic's first account — what `evm.bip44` group index 0 derives. */
const [SIGNER] = vectors.addresses;
if (SIGNER === undefined) {
  throw new Error("the evm vector has no addresses");
}

const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const TO = "0x00000000000000000000000000000000DeaDBeef";

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

const prompts = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt[] =>
  calls.flatMap((call) => (call.op === "open" && call.prompt !== undefined ? [call.prompt] : []));

/** The signer of a serialized envelope — the kernel output is a real signed transaction. */
const recoverSigner = async (serialized: `0x${string}`): Promise<`0x${string}`> =>
  recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized });

/** A vault unlocked for the session, holding the vector mnemonic's accounts. */
const setup = async (): Promise<{
  h: Harness;
  calls: KeystoreCall[];
  session: string;
  walletId: string;
}> => {
  const fake = fakeKeystore();
  const h = createHarness({ keystore: fake.keystore });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(vectors.mnemonic),
      factor: DEVICE,
    }),
  );
  return {
    h,
    calls: fake.calls,
    session: str(res, "session"),
    walletId: str(field(res, "wallet"), "walletId"),
  };
};

describe("chain.sign across the built-in EVM networks", () => {
  it.each(EVM_NETWORKS)("signs an eip1559 native transfer on $name ($id)", async (meta) => {
    const { h, calls, session, walletId } = await setup();
    const request = normalizeEvm({
      kind: "evm.transaction",
      network: meta.id,
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      tx: {
        type: "eip1559",
        chainId: meta.chainId,
        nonce: 0,
        gas: "0x5208",
        to: TO,
        value: "0x1",
        data: "0x",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });
    const res = ok(await h.call("chain.sign", { request, verify: HARDWARE }, session));
    const serializedTransaction = bytesToHex(bytes(res, "signedTransaction"));
    const parsed = parseTransaction(serializedTransaction);
    expect(parsed.type).toBe("eip1559");
    expect(parsed.chainId).toBe(meta.chainId);
    await expect(recoverSigner(serializedTransaction)).resolves.toBe(SIGNER);
    expect(prompts(calls).at(-1)?.description).toContain(meta.name);
  });

  it.each(EVM_NETWORKS)("signs a legacy native transfer on $name ($id)", async (meta) => {
    const { h, session, walletId } = await setup();
    const request = normalizeEvm({
      kind: "evm.transaction",
      network: meta.id,
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      tx: {
        type: "legacy",
        chainId: meta.chainId,
        nonce: 0,
        gas: "0x5208",
        to: TO,
        value: "0x1",
        data: "0x",
        gasPrice: "0x3b9aca00",
      },
    });
    const res = ok(await h.call("chain.sign", { request, verify: HARDWARE }, session));
    const serializedTransaction = bytesToHex(bytes(res, "signedTransaction"));
    const parsed = parseTransaction(serializedTransaction);
    expect(parsed.type).toBe("legacy");
    expect(parsed.chainId).toBe(meta.chainId);
    await expect(recoverSigner(serializedTransaction)).resolves.toBe(SIGNER);
  });
});
