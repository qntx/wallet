// `sparkRisk` only assesses "transfer" and "token" displays, so a `pay` to a bitcoin address —
// a cooperative exit whose receiver is that L1 address — never reaches `assessRecipients`: an
// exit paying an address-poisoned lookalike of a saved bitcoin contact raises no warning at all.

import { describe, expect, it } from "vite-plus/test";

import type { Event } from "@qntx/nostr";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { RequestController } from "../../src/requests/controller.ts";
import { assessRecipients } from "../../src/requests/risk.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import type { TransactionController } from "../../src/transactions/controller.ts";
import { bookDeps, simulateSolanaStub, tokensStub } from "../send-helpers.ts";

const ORIGIN = { kind: "browser", origin: "https://app.example" } as const;
const ACCOUNT: SparkAccountRef = { walletId: "w", groupIndex: 0, network: "mainnet" };
/* A saved mainnet contact and a real lookalike of it: both valid bech32, same first four and
   last four characters — what an address poisoner needs the payer not to notice. */
const CONTACT = "bc1quxxhnhxxnxzllhwrzsm4z234rd0kn2m62zqqyf";
const LOOKALIKE = "bc1q6kwhveta83psflhk4z4g3ydj69a7ve9gxfqqyf";

const rig = () => {
  const { addressBook, openStore } = bookDeps();
  const spark = {
    quoteExit: async (_ref: unknown, params: { amountSats: number }) =>
      Promise.resolve({ feeSats: 1, exitSats: params.amountSats + 1 }),
    withdraw: async () => Promise.reject(new Error("not reached")),
  } as unknown as SparkController;
  const transactions = {
    getState: () => ({ txs: {} }),
  } as unknown as TransactionController;
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    addressBook,
    openStore,
    spark,
    nostrSign: async (_ref: unknown, _event: unknown): Promise<Event> => {
      await Promise.resolve();
      throw new Error("nostr-sign is not wired in this test");
    },
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    setTimer: () => () => undefined,
    logger: { warn: () => undefined },
  });
  return { requests, addressBook };
};

describe("a spark exit's bitcoin recipient is never assessed", () => {
  it("an exit paying a lookalike of a saved contact carries no recipient finding", async () => {
    const { requests, addressBook } = rig();
    await requests.init();
    await addressBook.init();
    await addressBook.add({ name: "cold storage", family: "bitcoin", address: CONTACT });
    const request = await requests.prepare({
      method: "pay",
      origin: ORIGIN,
      account: ACCOUNT,
      option: { kind: "bitcoin", address: LOOKALIKE },
      amountSats: 10_000,
      maxFeeSats: 50,
    });
    expect(request.display).toMatchObject({ kind: "exit", receiver: LOOKALIKE });
    const codes = request.risk.map((finding) => finding.code);
    /* The rule itself would have fired — the exit path just never runs it. */
    expect(codes).not.toContain("address-poisoning");
    expect(codes).not.toContain("first-recipient");
    expect(assessRecipients("bitcoin", [LOOKALIKE], [CONTACT]).map((f) => f.code)).toStrictEqual([
      "address-poisoning",
      "first-recipient",
    ]);
  });
});
