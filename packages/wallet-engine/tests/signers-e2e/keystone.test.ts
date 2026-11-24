/**
 * Engine e2e sends through a Keystone: the wallet pairs from the shipped sync vector, then a native
 * transfer per family runs prepare → approve → device sign → broadcast through the real request
 * pipeline against the hermetic stubs. The caught wire bytes verify with independent libraries —
 * viem, @scure/btc-signer + noble, @solana/kit + noble, tronweb protobufs + noble.
 */
import { describe, expect, it } from "vite-plus/test";

import { WalletError } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";

import { VERIFY } from "../apps-helpers.ts";
import { keystoneIo, pairKeystone } from "../keystone-io.ts";
import {
  BTC_NETWORK,
  BTC_TO,
  btcAddressFromXpub,
  caughtOne,
  dappRefusal,
  e2eWorld,
  EVM_NETWORK,
  EVM_TO,
  matrix,
  matrixAccount,
  qrRefusal,
  sendOnce,
  SITE,
  SOL_NETWORK,
  SOL_TO,
  TRON_NETWORK,
  TRON_TO,
  verifyBtc,
  verifyEvm,
  verifySol,
  verifyTron,
  watchSignerActivity,
} from "./harness.ts";
import type { E2eWorld } from "./harness.ts";

type FamilyTemplate = "evm.bip44" | "btc.bip84" | "solana.bip44-change" | "tron.bip44";

const address = async (
  w: E2eWorld["w"],
  hwId: string,
  template: FamilyTemplate,
  network: string,
): Promise<string> => {
  const account = await chains(w.wallet).account({
    walletId: hwId,
    groupIndex: 0,
    template,
    network,
  });
  if ("address" in account) {
    return account.address;
  }
  /* BTC answers the account-level xpub; the funded address is receive index 0. */
  return btcAddressFromXpub(account.xpub);
};

const accountRef = (hwId: string, template: FamilyTemplate) =>
  ({ kind: "hd", walletId: hwId, groupIndex: 0, template }) as const;

describe("keystone engine sends", () => {
  it("signs and broadcasts a native transfer per family, verified byte-exact", async () => {
    const { w, caught, fund } = await e2eWorld({ deviceIo: () => keystoneIo() });
    const hwId = await pairKeystone(w.wallet);

    /* Account material comes off the pinned sync — no second device round-trip. */
    const evmFrom = await address(w, hwId, "evm.bip44", EVM_NETWORK);
    const btcFrom = await address(w, hwId, "btc.bip84", BTC_NETWORK);
    const solFrom = await address(w, hwId, "solana.bip44-change", SOL_NETWORK);
    const tronFrom = await address(w, hwId, "tron.bip44", TRON_NETWORK);
    const funded = fund(btcFrom, 100_000);

    const activity = watchSignerActivity(w);

    const evmTx = await sendOnce(w, {
      account: accountRef(hwId, "evm.bip44"),
      network: EVM_NETWORK,
      to: EVM_TO,
      amount: 1_000_000_000_000_000n,
      fee: "normal",
    });
    expect(evmTx.state).not.toBe("failed");
    await verifyEvm(caughtOne(caught, "evm"), {
      from: evmFrom,
      to: EVM_TO,
      amount: 1_000_000_000_000_000n,
    });

    const btcTx = await sendOnce(w, {
      account: accountRef(hwId, "btc.bip84"),
      network: BTC_NETWORK,
      to: BTC_TO,
      amount: 20_000n,
      fee: "normal",
    });
    expect(btcTx.state).not.toBe("failed");
    verifyBtc(caughtOne(caught, "bitcoin"), {
      fromAddress: btcFrom,
      to: BTC_TO,
      amount: 20_000n,
      inputSats: BigInt(funded.value),
    });

    const solTx = await sendOnce(w, {
      account: accountRef(hwId, "solana.bip44-change"),
      network: SOL_NETWORK,
      to: SOL_TO,
      amount: 1_000_000n,
      fee: "normal",
    });
    expect(solTx.state).not.toBe("failed");
    verifySol(caughtOne(caught, "solana"), { from: solFrom, to: SOL_TO, amount: 1_000_000n });

    const tronTx = await sendOnce(w, {
      account: accountRef(hwId, "tron.bip44"),
      network: TRON_NETWORK,
      to: TRON_TO,
      amount: 5_000_000n,
      fee: "normal",
    });
    expect(tronTx.state).not.toBe("failed");
    verifyTron(caughtOne(caught, "tron"), { from: tronFrom, to: TRON_TO, amount: 5_000_000n });

    activity.stop();
    /* starting → device exchange steps → cleared, once per send. */
    expect(activity.steps).toContain("starting");
    expect(activity.steps).toContain("device");
    expect(activity.steps.at(-1)).toBe("cleared");

    await w.destroy();
  });
});

matrix("keystone", VERIFY, async () => {
  const e2e = await e2eWorld({ deviceIo: () => keystoneIo() });
  const hwId = await pairKeystone(e2e.w.wallet);
  const account = await matrixAccount(e2e.w, hwId);
  return { e2e, account };
});

describe("keystone typed refusals", () => {
  /* The driver's display table marks tron.typed-data and a non-legacy/1559 evm transaction
     `unsupported` — the refusal must reach the caller before any exchange touches the device,
     whichever origin asked. */
  it("an unsignable request kind is refused on the dApp and QR origins with zero exchanges", async () => {
    const base = keystoneIo();
    let exchanges = 0;
    const e2e = await e2eWorld({
      deviceIo: () => ({
        exchange: async (request, context) => {
          exchanges += 1;
          return base.exchange(request, context);
        },
      }),
    });
    const hwId = await pairKeystone(e2e.w.wallet);
    const account = await matrixAccount(e2e.w, hwId);

    const dapp = await dappRefusal(e2e, account, "tron", VERIFY, async () =>
      e2e.dapp.tronWallet.handle(SITE, {
        method: "tron_signTypedData",
        params: {
          domain: { name: "D" },
          types: { Mail: [{ name: "text", type: "string" }] },
          message: { text: "hello" },
        },
      }),
    );
    expect(dapp.approve).toBeInstanceOf(WalletError);
    expect((dapp.approve as WalletError).code).toBe("unsupported");
    /* The page sees the wire refusal (EIP-1193 4001) carrying the kernel's typed reason — not a
       generic -32603 internal error. */
    expect(dapp.call).toMatchObject({ code: 4001 });
    expect(dapp.call).toBeInstanceOf(Error);
    expect((dapp.call as Error).message).toContain("unsupported");

    /* The QR request keeps the wire's transaction type, which `eth_sendTransaction` does not —
       eip2930 is the QR origin's unsignable kind. */
    const qr = await qrRefusal(
      e2e,
      account,
      "evm",
      {
        family: "evm",
        kind: "transaction",
        tx: {
          type: "eip2930",
          chainId: 42161,
          nonce: 0,
          gas: "0x5208",
          to: EVM_TO,
          value: "0x1",
          data: "0x",
          accessList: [],
          gasPrice: "0x64",
        },
      },
      VERIFY,
    );
    expect(qr.approve).toBeInstanceOf(WalletError);
    expect((qr.approve as WalletError).code).toBe("unsupported");
    expect(qr.call).toMatchObject({ stage: "rejected" });
    expect(qr.call).toBeInstanceOf(Error);
    expect((qr.call as Error).message).toContain("unsupported");

    expect(exchanges).toBe(0);
    expect(e2e.caught).toHaveLength(0);
    await e2e.w.destroy();
  });
});
