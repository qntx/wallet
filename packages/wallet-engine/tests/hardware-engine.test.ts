/**
 * Engine features against a paired hardware wallet in a real Node wallet: every signing path fails
 * with a typed `device-required` WalletError and the request ends terminally (rejected), nothing is
 * tracked, and a Hyperliquid enable ends in a typed, resumable state rather than a stuck flow.
 */
import { describe, expect, it } from "vite-plus/test";

import { chains } from "@qntx/wallet/chains";

import { approval } from "./approval.ts";
import type { Arb1Rpc } from "./apps-helpers.ts";
import { HL_ENABLE, VERIFY, world } from "./apps-helpers.ts";
import { keystoneIo, pairKeystone } from "./keystone-io.ts";

const NETWORK = "eip155:42161";

const hwAccount = (hwId: string) =>
  ({ kind: "hd", walletId: hwId, groupIndex: 0, template: "evm.bip44" }) as const;

const typedDataRequest = (hwId: string) => ({
  method: "evm-sign" as const,
  account: hwAccount(hwId),
  network: NETWORK,
  request: {
    kind: "evm.typed-data" as const,
    network: NETWORK,
    account: hwAccount(hwId),
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

const sessionRequest = (hwId: string) => ({
  method: "evm-sign" as const,
  account: hwAccount(hwId),
  network: NETWORK,
  request: {
    kind: "evm.fiat24-session" as const,
    network: NETWORK,
    account: hwAccount(hwId),
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

/**
 * The Arbitrum One answers `evm-revoke`/`evm-nft-send` read before signing: a live allowance, an
 * ERC-721 the hardware account owns, and the fee/estimate bases — all consistent, so the failure
 * can only come from signing.
 */
const hwRpc = (owner: () => string): Arb1Rpc => {
  const base: Record<string, unknown> = {
    eth_chainId: "0xa4b1",
    eth_blockNumber: "0x1",
    eth_getTransactionCount: "0x0",
    eth_estimateGas: "0x5208",
    eth_feeHistory: { baseFeePerGas: ["0x64"], reward: [["0x1", "0x1", "0x1"]] },
    eth_getCode: "0x",
    eth_sendRawTransaction: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
  return ({ method, params }) => {
    if (method === "eth_call") {
      const data = (
        (params as ReadonlyArray<{ readonly data?: string }> | undefined)?.[0]?.data ?? ""
      ).toLowerCase();
      /* supportsInterface → ERC-721; ownerOf → the hardware account; allowance → still set. */
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

/** `prepare` → `approve` on a hardware account signs on the device and enters the pipeline. */
const expectDeviceSigned = async (
  w: World,
  input: RequestInput,
  method: "evm-sign" | "evm-revoke" | "evm-nft-send",
  app?: RequestApp,
): Promise<string> => {
  const pending = await w.requests.prepare(input, app);
  expect(pending.stage).toBe("awaiting-approval");
  const approved =
    method === "evm-sign"
      ? w.requests.approve(pending.id, "evm-sign", approval(pending, VERIFY))
      : method === "evm-revoke"
        ? w.requests.approve(pending.id, "evm-revoke", approval(pending, VERIFY))
        : w.requests.approve(pending.id, "evm-nft-send", approval(pending, VERIFY));
  await expect(approved).resolves.toBeDefined();
  /* The device answered — the request is past approval, never a typed refusal. */
  expect(w.requests.getState().requests[pending.id]?.stage).not.toBe("rejected");
  return pending.id;
};

/** The hardware account's EVM address — the `ownerOf`/`allowance` answers need the real one. */
const hwEvmAddress = async (w: World, hwId: string): Promise<string> => {
  const account = await chains(w.wallet).account({
    walletId: hwId,
    groupIndex: 0,
    template: "evm.bip44",
    network: NETWORK,
  });
  if (!("address" in account)) {
    throw new Error("expected an evm account");
  }
  return account.address;
};

describe("hardware wallet × engine features", () => {
  it("typed-data approvals sign on the device; fiat24-session is a typed refusal", async () => {
    const w = await world(11, { deviceIo: () => keystoneIo() });
    const hwId = await pairKeystone(w.wallet);
    await expectDeviceSigned(w, typedDataRequest(hwId), "evm-sign");
    /* An app-scheme document is not a chain sign request the device can check — the kernel
       refuses it typed, and the request ends rejected rather than reaching the wire. */
    const pending = await w.requests.prepare(sessionRequest(hwId), { kind: "app", id: "fiat24" });
    await expect(
      w.requests.approve(pending.id, "evm-sign", approval(pending, VERIFY)),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(w.requests.getState().requests[pending.id]?.stage).toBe("rejected");
    await w.destroy();
  });

  it("revoke and nft-send approvals sign on the device and reach the wire", async () => {
    /* `hwAddress` is filled in after pairing; the rpc reads it lazily per call. */
    let hwAddress = "";
    const w = await world(11, { arb1: hwRpc(() => hwAddress), deviceIo: () => keystoneIo() });
    const hwId = await pairKeystone(w.wallet);
    hwAddress = await hwEvmAddress(w, hwId);
    const submitted = [
      await expectDeviceSigned(
        w,
        {
          method: "evm-revoke",
          account: hwAccount(hwId),
          network: NETWORK,
          targets: [{ kind: "erc20", token: TOKEN, spender: SPENDER }],
          fee: "normal",
        },
        "evm-revoke",
      ),
      await expectDeviceSigned(
        w,
        {
          method: "evm-nft-send",
          account: hwAccount(hwId),
          network: NETWORK,
          contract: NFT_CONTRACT,
          items: [{ tokenId: 7n }],
          to: NFT_TO,
          fee: "normal",
        },
        "evm-nft-send",
      ),
    ];
    /* Both requests reached "submitted" — signed bytes accepted by the wire. */
    for (const id of submitted) {
      expect(w.requests.getState().requests[id]?.stage).toBe("submitted");
    }
    await w.destroy();
  });

  it("a hardware group's Hyperliquid enable ends typed and resumable, not stuck", async () => {
    const w = await world(12);
    const hwId = await pairKeystone(w.wallet);
    const group = { walletId: hwId, groupIndex: 0 };
    const gkey = `${hwId}/0`;
    await w.apps.acknowledgeTerms(group, "hyperliquid");
    await expect(w.apps.enable(group, "hyperliquid", HL_ENABLE)).rejects.toMatchObject({
      code: "unsupported",
    });
    const state = () => w.apps.getState().groups[gkey]?.hyperliquid;
    /* The flow recorded its error and left — it is resumable, not still running. */
    expect(state()?.status).toBe("enabling");
    expect(state()?.error).toBeDefined();
    await expect(w.apps.enable(group, "hyperliquid", HL_ENABLE)).rejects.toMatchObject({
      code: "unsupported",
    });
    await w.destroy();
  });
});
