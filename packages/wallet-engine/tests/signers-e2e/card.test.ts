/**
 * Engine e2e sends through the real qntx card applet in the simulator bridge (`QNTX_CARD_SIM`,
 * skipped without it — the same gating as the kernel sim suites, and like them the file stays in
 * the unit project). A k=1 card wallet imports the rig's mnemonic onto a sim card through the
 * facade; a generated k=2 set over two more sim cards shows the account tree marking the wallet
 * `incomplete` — no groups — while a member is pending and `ready` when the set finishes. Each
 * family then sends a native transfer through the pipeline, the tap answered by the bridge, every
 * caught broadcast verified with the independent libraries, and engine.signers activity runs
 * starting -> card input/tap -> cleared.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { card } from "@qntx/wallet/card";
import { chains } from "@qntx/wallet/chains";

import { shortId } from "../../../wallet-kernel/src/modules/card/protocol/identity.ts";
import { SIM_LAUNCHER, startSimulator } from "../../../wallet-kernel/tests/card/sim.ts";
import type { SimCard } from "../../../wallet-kernel/tests/card/sim.ts";
import { AccountTreeController } from "../../src/accounts/controller.ts";
import type { SparkController } from "../../src/spark/controller.ts";
import type { SendParams, TrackedTransaction } from "../../src/transactions/route.ts";
import { approval } from "../approval.ts";
import { until } from "../apps-helpers.ts";
import { CARD_CODE, CARD_VERIFY, cardRig } from "../card-rig.ts";
import type { CardRig } from "../card-rig.ts";
import {
  BTC_NETWORK,
  BTC_TO,
  btcAddressFromXpub,
  caughtOne,
  e2eWorld,
  EVM_NETWORK,
  EVM_TO,
  SOL_NETWORK,
  SOL_TO,
  TRON_NETWORK,
  TRON_TO,
  verifyBtc,
  verifyEvm,
  verifySol,
  verifyTron,
} from "./harness.ts";
import type { E2eWorld } from "./harness.ts";

/** The inner card step the activity currently shows, if any. */
const activeCardStep = (w: E2eWorld["w"]): string | undefined => {
  const step = w.signers.getState().active?.step;
  return step?.kind === "card" ? step.step.kind : undefined;
};

/**
 * Every activity step's kind over the run — `card:input`/`card:tap` for the inner card steps —
 * collected until `stop`.
 */
const watchCardActivity = (
  w: E2eWorld["w"],
): { readonly steps: string[]; readonly stop: () => void } => {
  const steps: string[] = [];
  const stop = w.signers.store.subscribe((state) => {
    const step = state.active?.step;
    steps.push(
      step === undefined ? "cleared" : step.kind === "card" ? `card:${step.step.kind}` : step.kind,
    );
  });
  return { steps, stop };
};

type FamilyTemplate = "evm.bip44" | "btc.bip84" | "solana.bip44-change" | "tron.bip44";

const address = async (
  w: E2eWorld["w"],
  cardWalletId: string,
  template: FamilyTemplate,
  network: string,
): Promise<string> => {
  const account = await chains(w.wallet).account({
    walletId: cardWalletId,
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

const accountRef = (cardWalletId: string, template: FamilyTemplate) =>
  ({ kind: "hd", walletId: cardWalletId, groupIndex: 0, template }) as const;

/**
 * One engine send on a card wallet: the access code must be queued before approve — a held input
 * request never sees a later push — then the tap step is answered by presenting the sim card.
 */
const cardSendOnce = async (
  w: E2eWorld["w"],
  rig: CardRig,
  member: SimCard,
  params: Omit<SendParams, "verify">,
): Promise<TrackedTransaction> => {
  const request = await w.requests.prepare({ method: "send", ...params });
  expect(request.stage).toBe("awaiting-approval");
  rig.input.push(utf8ToBytes(CARD_CODE));
  const tracked = w.requests.approve(request.id, "send", approval(request, CARD_VERIFY));
  await until(() => activeCardStep(w) === "tap", 1200);
  rig.reader.present(member);
  return tracked;
};

/** The account tree over the rig's real wallet — `reconcile` before each read (engine-driven). */
const accountTree = (wallet: Wallet): AccountTreeController =>
  new AccountTreeController({
    setTimer: () => () => undefined,
    wallet,
    spark: {
      getState: () => ({ accounts: {} }),
      store: { subscribe: () => () => {} },
      setAccounts: () => {},
    } as unknown as SparkController,
    sparkNetwork: "regtest",
    chains: chains(wallet),
    networks: {
      enabled: (family: string) => {
        if (family === "bitcoin") {
          return [BTC_NETWORK];
        }
        if (family === "solana") {
          return [SOL_NETWORK];
        }
        return family === "tron" ? [TRON_NETWORK] : [EVM_NETWORK];
      },
      esplora: () => ({}),
    } as never,
    logger: { warn: () => {} },
    now: () => 1,
  });

/** What the pending-member window showed: the tree's state and groups while the tap waited. */
type PendingWindow = {
  readonly state: string | undefined;
  readonly groups: unknown;
};

/**
 * Generates a k=2 card set through the facade on two sim cards: short-id inputs name the card the
 * next tap presents (the target is offered first, then the source), the first tap OFFERs the
 * target, unnamed taps after it are the source's, and the named IMPORT tap — the target's short id
 * — is the window where its member is still pending. Returns the window observation and the new
 * card wallet's id.
 */
const createSet = async (
  rig: CardRig,
  tree: AccountTreeController,
  target: SimCard,
  source: SimCard,
): Promise<{ readonly pending: PendingWindow; readonly walletId: string }> => {
  const byShortId = new Map([target, source].map((c) => [shortId(c.identity), c] as const));
  const ids = [shortId(target.identity), shortId(source.identity)];
  let firstTap = true;
  let pending: PendingWindow | undefined;
  const created = card(rig.wallet).start(
    { kind: "create", cards: 2, source: { kind: "generate" } },
    { verify: CARD_VERIFY },
  );
  created.observe((step) => {
    if (step.kind === "input") {
      rig.input.push(
        step.purpose === "short-id" ? utf8ToBytes(ids.shift() ?? "") : utf8ToBytes(CARD_CODE),
      );
      return;
    }
    if (step.kind !== "tap") {
      return;
    }
    let which: SimCard | undefined;
    if (step.card === undefined) {
      which = firstTap ? target : source;
      firstTap = false;
    } else {
      which = byShortId.get(step.card);
      if (which === undefined) {
        throw new Error(`tap names an unknown card ${step.card}`);
      }
      if (which === target) {
        /* The IMPORT tap — the record holds the target as pending right now, and the source
           CREATE already committed, so reconcile sees it synchronously. */
        tree.reconcile();
        const seen = tree
          .getState()
          .wallets.find((x) => x.walletId !== rig.cardWalletId && x.custody === "card");
        pending = {
          state: seen?.state,
          groups: seen === undefined ? undefined : tree.getState().groups[seen.walletId],
        };
      }
    }
    rig.reader.present(which);
  });
  const made = await created.result;
  if (made.kind !== "create") {
    throw new Error("the set was not created");
  }
  if (pending === undefined) {
    throw new Error("the pending-member window was never observed");
  }
  return { pending, walletId: made.walletId };
};

describe.skipIf(SIM_LAUNCHER === undefined)("card engine sends (applet simulator)", () => {
  it("creates on the applet, observes a pending member, then sends a native transfer per family", async () => {
    const simulator = await startSimulator();
    try {
      const member = await simulator.newCard();
      const rig = await cardRig({ member });
      const { w, caught, fund } = await e2eWorld({
        wallet: { wallet: rig.wallet, walletId: rig.cardWalletId },
      });
      const tree = accountTree(rig.wallet);
      await tree.init();

      const set = await createSet(rig, tree, await simulator.newCard(), await simulator.newCard());
      /* While the target member was pending the tree marked the wallet incomplete — no groups —
         and the finished set is ready. */
      expect(set.pending.state).toBe("incomplete");
      expect(set.pending.groups).toStrictEqual([]);
      tree.reconcile();
      expect(tree.getState().wallets.find((x) => x.walletId === set.walletId)?.state).toBe("ready");
      await tree.destroy();

      const evmFrom = await address(w, rig.cardWalletId, "evm.bip44", EVM_NETWORK);
      const btcFrom = await address(w, rig.cardWalletId, "btc.bip84", BTC_NETWORK);
      const solFrom = await address(w, rig.cardWalletId, "solana.bip44-change", SOL_NETWORK);
      const tronFrom = await address(w, rig.cardWalletId, "tron.bip44", TRON_NETWORK);
      const funded = fund(btcFrom, 100_000);

      const activity = watchCardActivity(w);

      const evmTx = await cardSendOnce(w, rig, member, {
        account: accountRef(rig.cardWalletId, "evm.bip44"),
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

      const btcTx = await cardSendOnce(w, rig, member, {
        account: accountRef(rig.cardWalletId, "btc.bip84"),
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

      const solTx = await cardSendOnce(w, rig, member, {
        account: accountRef(rig.cardWalletId, "solana.bip44-change"),
        network: SOL_NETWORK,
        to: SOL_TO,
        amount: 1_000_000n,
        fee: "normal",
      });
      expect(solTx.state).not.toBe("failed");
      verifySol(caughtOne(caught, "solana"), { from: solFrom, to: SOL_TO, amount: 1_000_000n });

      const tronTx = await cardSendOnce(w, rig, member, {
        account: accountRef(rig.cardWalletId, "tron.bip44"),
        network: TRON_NETWORK,
        to: TRON_TO,
        amount: 5_000_000n,
        fee: "normal",
      });
      expect(tronTx.state).not.toBe("failed");
      verifyTron(caughtOne(caught, "tron"), { from: tronFrom, to: TRON_TO, amount: 5_000_000n });

      activity.stop();
      /* starting → card input/tap steps → cleared, once per send. */
      expect(activity.steps).toContain("starting");
      expect(activity.steps).toContain("card:input");
      expect(activity.steps).toContain("card:tap");
      expect(activity.steps.at(-1)).toBe("cleared");

      await w.destroy();
    } finally {
      await simulator.close();
    }
  }, 300_000);
});
