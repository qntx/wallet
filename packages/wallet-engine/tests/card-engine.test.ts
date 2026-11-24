/**
 * Engine features against a card wallet in a real Node wallet: typed-data, evm-revoke and
 * evm-nft-send sign on the member card and enter the pipeline; fiat24-session, a Hyperliquid
 * enable, Spark and Nostr are typed refusals (a card wallet holds no seed); cancelling the tap
 * through `signers.cancel` ends the request rejected with nothing broadcast.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { chains } from "@qntx/wallet/chains";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";

import { approval } from "./approval.ts";
import type { Arb1Rpc } from "./apps-helpers.ts";
import { until, world } from "./apps-helpers.ts";
import type { CardRig } from "./card-rig.ts";
import { cardRig, CARD_CODE, CARD_VERIFY } from "./card-rig.ts";

const NETWORK = "eip155:42161";

const cardAccount = (cardWalletId: string) =>
  ({ kind: "hd", walletId: cardWalletId, groupIndex: 0, template: "evm.bip44" }) as const;

const typedDataRequest = (cardWalletId: string) => ({
  method: "evm-sign" as const,
  account: cardAccount(cardWalletId),
  network: NETWORK,
  request: {
    kind: "evm.typed-data" as const,
    network: NETWORK,
    account: cardAccount(cardWalletId),
    typedData: JSON.stringify({
      types: {
        EIP712Domain: [],
        Mail: [{ name: "contents", type: "string" }],
      },
      primaryType: "Mail",
      domain: {},
      message: { contents: "hello" },
    }),
  },
});

const sessionRequest = (cardWalletId: string) => ({
  method: "evm-sign" as const,
  account: cardAccount(cardWalletId),
  network: NETWORK,
  request: {
    kind: "evm.fiat24-session" as const,
    network: NETWORK,
    account: cardAccount(cardWalletId),
    tokenId: "123456",
    deadline: 1795278000,
  },
});

const TOKEN = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x3333333333333333333333333333333333333333";
const NFT_CONTRACT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const NFT_TO = "0x1234567890abcdef1234567890abcdef12345678";

const word = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;
const addrWord = (a: string): string => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

/* Mirrors the hardware-engine stub: a live allowance, an owned ERC-721 and the fee bases. */
const cardRpc = (owner: () => string, raw: { count: number }): Arb1Rpc => {
  const base: Record<string, unknown> = {
    eth_chainId: "0xa4b1",
    eth_blockNumber: "0x1",
    eth_getTransactionCount: "0x0",
    eth_estimateGas: "0x5208",
    eth_feeHistory: { baseFeePerGas: ["0x64"], reward: [["0x1", "0x1", "0x1"]] },
    eth_getCode: "0x",
  };
  return ({ method, params }) => {
    if (method === "eth_sendRawTransaction") {
      raw.count += 1;
      return "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    }
    if (method === "eth_call") {
      const data = (
        (params as ReadonlyArray<{ readonly data?: string }> | undefined)?.[0]?.data ?? ""
      ).toLowerCase();
      if (data.startsWith("0x01ffc9a7")) {
        return word(data.slice(10, 18) === "80ac58cd" ? 1n : 0n);
      }
      if (data.startsWith("0x6352211e")) {
        return addrWord(owner());
      }
      if (data.startsWith("0xdd62ed3e")) {
        return word(80n);
      }
      return word(0n);
    }
    if (method === "eth_simulateV1") {
      return {
        status: "ok",
        blocks: [
          {
            calls: [{ status: "0x1", gasUsed: "0x5208", logs: [] }],
            assetChanges: [],
            balanceChanges: [],
          },
        ],
      };
    }
    if (!(method in base)) {
      throw new Error(`unstubbed rpc ${method}`);
    }
    return base[method];
  };
};

type World = Awaited<ReturnType<typeof world>>;
type RequestInput = Parameters<World["requests"]["prepare"]>[0];
type RequestApp = Parameters<World["requests"]["prepare"]>[1];
type Method = "evm-sign" | "evm-revoke" | "evm-nft-send";

/** The inner card step the activity currently shows, if any. */
const activeCardStep = (w: World): string | undefined => {
  const step = w.signers.getState().active?.step;
  return step?.kind === "card" ? step.step.kind : undefined;
};

/** `prepare` → `approve` on a card account signs on the card and enters the pipeline. */
const expectCardSigned = async (
  w: World,
  rig: CardRig,
  input: RequestInput,
  method: Method,
  app?: RequestApp,
): Promise<string> => {
  const pending = await w.requests.prepare(input, app);
  expect(pending.stage).toBe("awaiting-approval");
  /* Queue the access code before the op asks — a held input request never sees a later push. */
  rig.input.push(utf8ToBytes(CARD_CODE));
  const approved =
    method === "evm-sign"
      ? w.requests.approve(pending.id, "evm-sign", approval(pending, CARD_VERIFY))
      : method === "evm-revoke"
        ? w.requests.approve(pending.id, "evm-revoke", approval(pending, CARD_VERIFY))
        : w.requests.approve(pending.id, "evm-nft-send", approval(pending, CARD_VERIFY));
  await until(() => activeCardStep(w) === "tap");
  rig.reader.present(rig.member);
  await expect(approved).resolves.toBeDefined();
  expect(w.requests.getState().requests[pending.id]?.stage).not.toBe("rejected");
  return pending.id;
};

/** The card account's EVM address — the `ownerOf`/`allowance` answers need the real one. */
const cardEvmAddress = async (w: World, cardWalletId: string): Promise<string> => {
  const account = await chains(w.wallet).account({
    walletId: cardWalletId,
    groupIndex: 0,
    template: "evm.bip44",
    network: NETWORK,
  });
  if (!("address" in account)) {
    throw new Error("expected an evm account");
  }
  return account.address;
};

const cardWorld = async (arb1?: Arb1Rpc) =>
  cardRig().then(async (rig) => {
    const w = await world(11, {
      wallet: { wallet: rig.wallet, walletId: rig.cardWalletId },
      ...(arb1 === undefined ? {} : { arb1 }),
    });
    return { w, rig };
  });

describe("card wallet × engine features", () => {
  it("typed-data approvals sign on the card; fiat24-session is a typed refusal", async () => {
    const { w, rig } = await cardWorld();
    await expectCardSigned(w, rig, typedDataRequest(rig.cardWalletId), "evm-sign");
    const pending = await w.requests.prepare(sessionRequest(rig.cardWalletId), {
      kind: "app",
      id: "fiat24",
    });
    await expect(
      w.requests.approve(pending.id, "evm-sign", approval(pending, CARD_VERIFY)),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(w.requests.getState().requests[pending.id]?.stage).toBe("rejected");
    await w.destroy();
  });

  it("revoke and nft-send approvals sign on the card and reach the wire", async () => {
    let owner = "";
    const raw = { count: 0 };
    const { w, rig } = await cardWorld(cardRpc(() => owner, raw));
    owner = await cardEvmAddress(w, rig.cardWalletId);
    const submitted = [
      await expectCardSigned(
        w,
        rig,
        {
          method: "evm-revoke",
          account: cardAccount(rig.cardWalletId),
          network: NETWORK,
          targets: [{ kind: "erc20", token: TOKEN, spender: SPENDER }],
          fee: "normal",
        },
        "evm-revoke",
      ),
      await expectCardSigned(
        w,
        rig,
        {
          method: "evm-nft-send",
          account: cardAccount(rig.cardWalletId),
          network: NETWORK,
          contract: NFT_CONTRACT,
          items: [{ tokenId: 7n }],
          to: NFT_TO,
          fee: "normal",
        },
        "evm-nft-send",
      ),
    ];
    for (const id of submitted) {
      expect(w.requests.getState().requests[id]?.stage).toBe("submitted");
    }
    expect(raw.count).toBe(2);
    await w.destroy();
  });

  it("Spark, Nostr and exportMnemonic refuse the seedless wallet typed", async () => {
    const { w, rig } = await cardWorld();
    const signer = spark(w.wallet).signer({
      walletId: rig.cardWalletId,
      groupIndex: 0,
      network: "mainnet",
    });
    await expect(signer.identityPublicKey()).rejects.toMatchObject({ code: "unsupported" });
    await expect(nostr(w.wallet).deriveKey(rig.cardWalletId, 0)).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(
      w.wallet.wallets.exportMnemonic(rig.cardWalletId, CARD_VERIFY),
    ).rejects.toMatchObject({ code: "unsupported" });
    await w.destroy();
  });

  it("a card group's Hyperliquid enable ends typed and resumable, not stuck", async () => {
    const { w, rig } = await cardWorld();
    const group = { walletId: rig.cardWalletId, groupIndex: 0 };
    const gkey = `${rig.cardWalletId}/0`;
    await w.apps.acknowledgeTerms(group, "hyperliquid");
    await expect(w.apps.enable(group, "hyperliquid")).rejects.toMatchObject({
      code: "invalid-input",
    });
    const state = () => w.apps.getState().groups[gkey]?.hyperliquid;
    expect(state()?.status).toBe("enabling");
    expect(state()?.error).toBeDefined();
    await expect(w.apps.enable(group, "hyperliquid")).rejects.toMatchObject({
      code: "invalid-input",
    });
    await w.destroy();
  });

  it("cancelling the tap ends the request rejected and nothing is broadcast", async () => {
    let owner = "";
    const raw = { count: 0 };
    const { w, rig } = await cardWorld(cardRpc(() => owner, raw));
    owner = await cardEvmAddress(w, rig.cardWalletId);
    const pending = await w.requests.prepare(
      {
        method: "evm-revoke",
        account: cardAccount(rig.cardWalletId),
        network: NETWORK,
        targets: [{ kind: "erc20", token: TOKEN, spender: SPENDER }],
        fee: "normal",
      },
      undefined,
    );
    const approved = w.requests.approve(pending.id, "evm-revoke", approval(pending, CARD_VERIFY));
    /* Queue the access code before the op asks — a held input request never sees a later push. */
    rig.input.push(utf8ToBytes(CARD_CODE));
    await until(() => activeCardStep(w) === "tap");
    /* The card is held on the reader prompt; the host cancels instead of presenting it. */
    await w.signers.cancel();
    await expect(approved).rejects.toMatchObject({ code: "cancelled" });
    expect(w.requests.getState().requests[pending.id]?.stage).toBe("rejected");
    expect(raw.count).toBe(0);
    await w.destroy();
  });
});
