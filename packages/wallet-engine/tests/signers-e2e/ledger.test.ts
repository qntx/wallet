/**
 * Engine e2e sends through a Ledger on Speculos: the pinned app containers from
 * scripts/ledger/speculos.ts run the seed the recorded vectors derive from, and the kernel speculos
 * harness — imported, not copied — provides the APDU transport and screen automation. Pairing on
 * the Bitcoin app pins only the bitcoin family; ethereum/tron/solana material is fetched through
 * engine.signers.fetchAccounts on the right app, and a second fetch of the same family re-proves
 * the answering device against the pin. Every send verifies the caught broadcast with the
 * independent libraries and the engine.signers activity runs starting -> device -> cleared.
 */
import { describe, expect, it } from "vite-plus/test";

import { WalletError } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import { hardware, ledgerIo } from "@qntx/wallet/hardware";
import type { DeviceIo } from "@qntx/wallet/hardware";

import { exchange, hasEndpoints, Screen } from "../../../wallet-kernel/tests/speculos/harness.ts";
import { freshNodeWallet, VERIFY } from "../apps-helpers.ts";
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
import type { E2eWorld, MatrixFamily, MatrixHooks } from "./harness.ts";

/* Exactly the kernel speculos suite's gating: the endpoints file exists only while the app
   containers run. */
const UP = hasEndpoints();

type LedgerApp = "bitcoin" | "ethereum" | "solana" | "tron";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/* Screen vocabulary, the same words the kernel speculos cases navigate by. */
const MENU = /app is ready|app settings|app info|quit app/i;
const THROUGH = /blind signing ahead|press both buttons|continue anyway/i;
const APPROVE = /accept|approve|confirm|sign transaction|sign typed message|sign message/i;

/**
 * The speculos DeviceIo: `app` names the container the next operation needs open — the test sets it
 * before each pair/fetch/send, and every exchange routes there. An APDU that stays silent past the
 * grace period is held by an on-screen review; navigate it to the approve page.
 */
const speculosIo = (): { readonly io: DeviceIo; readonly open: (app: LedgerApp) => void } => {
  let app: LedgerApp = "bitcoin";
  const screens: Record<LedgerApp, Screen> = {
    bitcoin: new Screen("bitcoin"),
    ethereum: new Screen("ethereum"),
    solana: new Screen("solana"),
    tron: new Screen("tron"),
  };
  const apdu = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const pending = exchange(app, bytes);
    const early = await Promise.race([
      pending.then((): boolean => true),
      sleep(500).then((): boolean => false),
    ]);
    if (!early) {
      void pending.catch(() => undefined);
      await screens[app].approve(APPROVE, { through: THROUGH, leave: MENU, maxSteps: 80 });
    }
    return pending;
  };
  return {
    io: ledgerIo(apdu),
    open: (next) => {
      app = next;
    },
  };
};

const pairLedger = async (w: E2eWorld["w"], io: DeviceIo): Promise<string> => {
  const result = await hardware(w.wallet).start(
    { kind: "pair", device: "ledger" },
    { io, verify: VERIFY },
  ).result;
  if (result.kind !== "pair" || result.wallet.custody !== "hardware") {
    throw new WalletError("integrity", "pair did not return a hardware wallet");
  }
  return result.wallet.walletId;
};

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

describe.skipIf(!UP)("ledger engine sends (speculos)", () => {
  it("pairs, fetches the other families with re-proof, and signs a native transfer per family", async () => {
    const speculos = speculosIo();
    const wallet = await freshNodeWallet();
    const { w, caught, fund } = await e2eWorld({ deviceIo: () => speculos.io, wallet });

    /* Pairing needs the Bitcoin app open — the only app that reveals the master fingerprint. */
    speculos.open("bitcoin");
    const hwId = await pairLedger(w, speculos.io);
    const btcFrom = await address(w, hwId, "btc.bip84", BTC_NETWORK);
    const funded = fund(btcFrom, 100_000);

    /* The pin carries only bitcoin: each other family is fetched on its own app, then fetched
       again so the driver re-proves the device against the pinned material. */
    const families = [
      ["evm", "ethereum"],
      ["solana", "solana"],
      ["tron", "tron"],
    ] as const;
    for (const [family, app] of families) {
      speculos.open(app);
      // oxlint-disable-next-line eslint/no-await-in-loop -- device ops are strictly sequential
      await w.signers.fetchAccounts({ walletId: hwId, groupIndex: 0, family, verify: VERIFY });
      /* Second fetch of the same family: the pin now holds this family's material, so nothing is
         missing and the fetch needs no verification — it stays free. */
      // oxlint-disable-next-line eslint/no-await-in-loop -- device ops are strictly sequential
      await w.signers.fetchAccounts({ walletId: hwId, groupIndex: 0, family });
    }
    const evmFrom = await address(w, hwId, "evm.bip44", EVM_NETWORK);
    const solFrom = await address(w, hwId, "solana.bip44-change", SOL_NETWORK);
    const tronFrom = await address(w, hwId, "tron.bip44", TRON_NETWORK);

    const activity = watchSignerActivity(w);

    speculos.open("ethereum");
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

    speculos.open("bitcoin");
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

    speculos.open("solana");
    const solTx = await sendOnce(w, {
      account: accountRef(hwId, "solana.bip44-change"),
      network: SOL_NETWORK,
      to: SOL_TO,
      amount: 1_000_000n,
      fee: "normal",
    });
    expect(solTx.state).not.toBe("failed");
    verifySol(caughtOne(caught, "solana"), { from: solFrom, to: SOL_TO, amount: 1_000_000n });

    speculos.open("tron");
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
  }, 300_000);
});

/* The app each family's sign needs open — pairing stays on Bitcoin, the only app that reveals
   the master fingerprint. */
const FAMILY_APP: Record<MatrixFamily, LedgerApp> = {
  evm: "ethereum",
  bitcoin: "bitcoin",
  solana: "solana",
  tron: "tron",
};

describe.skipIf(!UP)("ledger origins (speculos)", () => {
  let speculos: ReturnType<typeof speculosIo>;

  matrix(
    "ledger",
    VERIFY,
    async () => {
      speculos = speculosIo();
      const wallet = await freshNodeWallet();
      const e2e = await e2eWorld({ deviceIo: () => speculos.io, wallet });
      speculos.open("bitcoin");
      const hwId = await pairLedger(e2e.w, speculos.io);
      /* Pairing pins only bitcoin: fetch the other families' material once, on their own apps,
         so every origin can sign for them. */
      for (const [family, app] of [
        ["evm", "ethereum"],
        ["solana", "solana"],
        ["tron", "tron"],
      ] as const) {
        speculos.open(app);
        // oxlint-disable-next-line eslint/no-await-in-loop -- device ops are strictly sequential
        await e2e.w.signers.fetchAccounts({
          walletId: hwId,
          groupIndex: 0,
          family,
          verify: VERIFY,
        });
      }
      const account = await matrixAccount(e2e.w, hwId);
      return { e2e, account };
    },
    { beforeCell: (_origin, family) => speculos.open(FAMILY_APP[family]) } satisfies MatrixHooks,
  );

  describe("ledger typed refusals", () => {
    /* The driver's display requires a `solana.message` to be the formal v0 off-chain document —
       anything else is `unsupported`, and the refusal must reach the caller before any APDU
       touches the device. */
    it(
      "a non-offchain solana message is refused on the dApp and QR origins with zero APDUs",
      { timeout: 120_000 },
      async () => {
        const speculos = speculosIo();
        let apdus = 0;
        const wallet = await freshNodeWallet();
        const e2e = await e2eWorld({
          deviceIo: () => ({
            exchange: async (request, context) => {
              apdus += 1;
              return speculos.io.exchange(request, context);
            },
          }),
          wallet,
        });
        speculos.open("bitcoin");
        const hwId = await pairLedger(e2e.w, speculos.io);
        /* exportAccount covers every pinned family — fetch them all like the matrix setup. */
        for (const [family, app] of [
          ["evm", "ethereum"],
          ["solana", "solana"],
          ["tron", "tron"],
        ] as const) {
          speculos.open(app);
          // oxlint-disable-next-line eslint/no-await-in-loop -- device ops are strictly sequential
          await e2e.w.signers.fetchAccounts({
            walletId: hwId,
            groupIndex: 0,
            family,
            verify: VERIFY,
          });
        }
        const account = await matrixAccount(e2e.w, hwId);
        const before = apdus;

        /* Plain text: shown, not blind — the refusal is the device's, not the vault gate's. */
        const message = new TextEncoder().encode("hello, not an offchain document");
        const dapp = await dappRefusal(e2e, account, "solana", VERIFY, async () =>
          e2e.dapp.solanaWallet.handle(SITE, {
            method: "solana:signMessage",
            params: { message },
          }),
        );
        expect(dapp.approve).toBeInstanceOf(WalletError);
        expect((dapp.approve as WalletError).code).toBe("unsupported");
        expect(dapp.call).toBeInstanceOf(Error);
        expect((dapp.call as Error).message).toContain("unsupported");

        const qr = await qrRefusal(
          e2e,
          account,
          "solana",
          { family: "solana", kind: "message", data: message },
          VERIFY,
        );
        expect(qr.approve).toBeInstanceOf(WalletError);
        expect((qr.approve as WalletError).code).toBe("unsupported");
        expect(qr.call).toBeInstanceOf(Error);
        expect((qr.call as Error).message).toContain("unsupported");

        expect(apdus).toBe(before);
        await e2e.w.destroy();
      },
    );
  });
});
