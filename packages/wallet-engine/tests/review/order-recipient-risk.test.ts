/**
 * PoC for finding R-4 (order-recipient-no-check).
 *
 * Property that should hold: recipient assessment (`assessRecipients` → `first-recipient` /
 * `address-poisoning`) covers every destination a signature pays — including the recipients an
 * off-chain order names (`intent.message.order.receive[].recipient`), which is where the swap's
 * proceeds go.
 *
 * Current behaviour pinned here: the `evm-sign` typed-data branch (src/requests/controller.ts
 * ~L1147) computes `recipientRisk` from `intent.outflows` alone. An off-chain order lists no
 * outflows, so its `receive[].recipient` is never assessed — a 0x gasless MetaTxn paying a
 * lookalike of a known address yields no recipient findings, while the same lookalike as an
 * EIP-3009 transfer `to` is flagged `address-poisoning`.
 *
 * These assertions pin the buggy behaviour: they pass today and must be revisited by the fix.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";

import { AddressBookController } from "../../src/addresses/controller.ts";
import { RequestController } from "../../src/requests/controller.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import type { TransactionController } from "../../src/transactions/controller.ts";
import type { DisplayIntent } from "../../src/transactions/route.ts";
import { tokensStub } from "../send-helpers.ts";

const SEPOLIA = "eip155:11155111";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const SIGNER = "0x4D2A422dB44144996E855ce15FB581a477dbB947";
const KNOWN = "0x52908400098527886E0F7030069857D2E4169EE7";
const LOOKALIKE = "0x5290aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9EE7";

/** The committed 0x gasless Settler MetaTxn vector with its recipient swapped for the lookalike. */
const zeroxDoc = (recipient: string): string => {
  const vectors = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../../vectors/chains/evm-zerox-gasless.json"),
      "utf8",
    ),
  ) as { real: { data: { message: { slippageAndActions: { recipient: string } } & object } } };
  const data = structuredClone(vectors.real.data);
  data.message.slippageAndActions.recipient = recipient;
  return JSON.stringify(data);
};

const typedFields = (spec: string) =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

/** Mirrors tests/requests-risk-log.test.ts — an EIP-3009 TransferWithAuthorization paying `to`. */
const eip3009Doc = (to: string) =>
  JSON.stringify({
    types: {
      EIP712Domain: typedFields(
        "string name, string version, uint256 chainId, address verifyingContract",
      ),
      TransferWithAuthorization: typedFields(
        "address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce",
      ),
    },
    primaryType: "TransferWithAuthorization",
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 11155111,
      verifyingContract: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    },
    message: {
      from: SIGNER,
      to,
      value: "10000",
      validAfter: "0",
      validBefore: "1738886400",
      nonce: `0x${"00".repeat(31)}01`,
    },
  });

const rig = () => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const openStore = async () => Promise.resolve(createMemoryEngineStore(backing));
  const logger = { warn: () => undefined };
  const transactions = {
    getState: () => ({ txs: {} }),
    prepareDapp: async (account: unknown, request: unknown) => {
      const normalized = normalizeEvm(request);
      return Promise.resolve({
        account,
        network: normalized.network,
        signer: SIGNER,
        intent: decodeEvm(normalized, SIGNER),
        checks: [],
        staleReason: () => undefined,
        release: () => undefined,
        submit: async () => Promise.resolve({ kind: normalized.kind, signature: "0x1234" }),
      });
    },
  } as unknown as TransactionController;
  const addressBook = new AddressBookController({
    openStore,
    random: (n) => new Uint8Array(n).fill(7),
    now: () => 0,
    logger,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => true,
    tokens: tokensStub,
    simulateSolana: async () => Promise.reject(new Error("unused")),
    transactions,
    spark: {} as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    addressBook,
    openStore,
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  const start = async () => {
    await addressBook.init();
    await requests.init();
    await addressBook.add({ name: "Alice", family: "evm", address: KNOWN });
  };
  return { requests, start };
};

/** The off-chain order an evm typed-data intent carries (asserted separately below). */
const typedDataOrder = (intent: DisplayIntent) =>
  intent.message?.kind === "typed-data" ? intent.message.order : undefined;

const sign = (network: string, typedData: string) => ({
  method: "evm-sign" as const,
  account: ACCOUNT,
  network,
  request: { kind: "evm.typed-data" as const, network, account: ACCOUNT, typedData },
});

describe("R-4: an off-chain order's receive recipients are never assessed", () => {
  it("a 0x MetaTxn paying a lookalike of a known address yields no recipient risk", async () => {
    const { requests, start } = rig();
    await start();
    const request = await requests.prepare(sign("eip155:8453", zeroxDoc(LOOKALIKE)), {
      kind: "app",
      id: "polymarket",
    });
    const intent = request.display as DisplayIntent;
    // The order's proceeds land on the lookalike — proven by the decode itself.
    expect(intent.message?.kind).toBe("typed-data");
    expect(typedDataOrder(intent)?.receive[0]?.recipient?.toLowerCase()).toBe(
      LOOKALIKE.toLowerCase(),
    );
    // And outflows — the only list the branch assesses — is empty for an off-chain order.
    expect(intent.outflows).toStrictEqual([]);
    // The finding: no recipient finding at all.
    const codes = request.risk.map((r) => r.code);
    expect(codes).not.toContain("address-poisoning");
    expect(codes).not.toContain("first-recipient");
  });

  it("control: the same lookalike as an EIP-3009 `to` is flagged", async () => {
    const { requests, start } = rig();
    await start();
    const request = await requests.prepare(sign(SEPOLIA, eip3009Doc(LOOKALIKE)), {
      kind: "app",
      id: "polymarket",
    });
    expect(request.risk).toStrictEqual([
      { code: "address-poisoning", level: "danger" },
      { code: "first-recipient", level: "warning" },
    ]);
  });
});
