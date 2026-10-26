import type { UnlockFactor } from "@qntx/wallet";
import { createWalletEngine } from "@qntx/wallet-engine";
import { openIndexedDbEngineStore } from "@qntx/wallet-engine/idb";
import { createWebWallet } from "@qntx/wallet-worker/browser";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

function el(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`#${id}`);
  if (found === null) {
    throw new Error(`missing element #${id}`);
  }
  return found;
}
const input = (id: string): HTMLInputElement => {
  const found = document.querySelector<HTMLInputElement>(`#${id}`);
  if (found === null) {
    throw new Error(`missing input #${id}`);
  }
  return found;
};
const button = (id: string): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>(`#${id}`);
  if (found === null) {
    throw new Error(`missing button #${id}`);
  }
  return found;
};
const say = (msg: string, err = false): void => {
  el("status").textContent = msg;
  el("status").className = err ? "err" : "ok";
};
const verify = (): UnlockFactor => ({ kind: "password", password: input("password").value });
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

const wallet = await createWebWallet({
  passkey: {
    rpId: "localhost",
    rpName: "qntx playground",
    walletSalt: "qntx/wallet",
    vaultSalt: "qntx/vault",
  },
  autoLock: { platform: "web", idleMinutes: 15 },
});

const engine = createWalletEngine({
  wallet,
  fetch: globalThis.fetch.bind(globalThis),
  random,
  now: () => Date.now(),
  logger: { warn: (m: string, e?: unknown) => void [m, e] },
  openStore: async () =>
    openIndexedDbEngineStore({
      name: "playground-engine",
      dataKey: await wallet.dataKeys.get("wallet-db"),
      random,
    }),
});

let walletId = "";
const ref = (): SparkAccountRef => ({ walletId, groupIndex: 0, network: "regtest" });
const key = () => `${walletId}:0:regtest`;
const enable = (ids: string[], on: boolean): void => {
  for (const id of ids) {
    button(id).disabled = !on;
  }
};

button("create").addEventListener("click", () => {
  void (async () => {
    try {
      const factor: UnlockFactor = { kind: "password", password: input("password").value };
      const words = input("mnemonic").value.trim();
      if (words.length > 0) {
        const imported = await wallet.wallets.importMnemonic({ mnemonic: words, factor });
        ({ walletId } = imported);
      } else {
        const draft = await wallet.wallets.createMnemonic({ words: 12, factor });
        const ws = new TextDecoder().decode(draft.words.read()).split(" ");
        const picked = draft.quiz.map((p) => ws[p]).filter((w): w is string => w !== undefined);
        const created = await draft.confirm(picked);
        ({ walletId } = created);
        input("mnemonic").value = ws.join(" ");
      }
      say(`wallet ${walletId} created — unlock to connect`);
    } catch (error) {
      say(`create failed: ${String(error)}`, true);
    }
  })();
});

button("unlock").addEventListener("click", () => {
  void (async () => {
    try {
      await wallet.vault.unlock(verify());
      say("unlocked");
      enable(["addAccount"], true);
    } catch (error) {
      say(`unlock failed: ${String(error)}`, true);
    }
  })();
});

button("lock").addEventListener("click", () => {
  void (async () => {
    await wallet.vault.lock();
    el("accountState").textContent = "locked";
    say("locked");
  })();
});

button("addAccount").addEventListener("click", () => {
  engine.spark.addAccount(ref());
  const tick = (): void => {
    const s = engine.spark.getState().accounts[key()];
    const state = s?.status ?? "…";
    el("accountState").textContent = state;
    if (s?.sparkAddress !== undefined) {
      input("sparkAddr").value = s.sparkAddress;
      el("balance").textContent = `${s.balanceSats ?? 0} sats`;
      enable(["createInvoice", "payInvoice", "send", "withdrawBtn"], true);
    }
    if (state !== "ready" && state !== "error") {
      setTimeout(tick, 500);
    } else if (state === "error") {
      say(`account error: ${String(s?.errorCategory)}`, true);
    }
  };
  tick();
});

const action = (id: string, label: string, run: () => Promise<unknown>): void => {
  button(id).addEventListener("click", () => {
    void (async () => {
      say(`${label}…`);
      try {
        const r = await run();
        say(`${label}: ${JSON.stringify(r).slice(0, 200)}`);
      } catch (error) {
        say(`${label} failed: ${String(error)}`, true);
      }
    })();
  });
};

action("createInvoice", "invoice", async () => {
  const { invoice } = await engine.spark.createInvoice(ref(), {
    amountSats: Number(input("invoiceAmount").value),
  });
  input("invoice").value = invoice;
  return invoice.slice(0, 40);
});
action("payInvoice", "pay", async () =>
  engine.spark.payInvoice(ref(), {
    invoice: input("invoice").value,
    maxFeeSats: 100,
    verify: verify(),
  }),
);
action("send", "send", async () =>
  engine.spark.send(ref(), {
    receiver: input("invoice").value,
    amountSats: Number(input("invoiceAmount").value),
    verify: verify(),
  }),
);
action("withdrawBtn", "withdraw", async () => {
  const amt = input("withdrawAmount").value.trim();
  return engine.spark.withdraw(ref(), {
    address: input("l1addr").value,
    speed: "MEDIUM",
    ...(amt.length === 0 ? {} : { amountSats: Number(amt) }),
    verify: verify(),
  });
});
