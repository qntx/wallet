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
const pickerEl = (): HTMLSelectElement => {
  const found = document.querySelector<HTMLSelectElement>("#groupPicker");
  if (found === null) {
    throw new Error("missing #groupPicker");
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
const errText = (e: unknown): string => {
  if (e instanceof Error && "category" in e) {
    return String((e as { category: unknown }).category);
  }
  return String(e);
};
const say = (msg: string, err = false): void => {
  el("status").textContent = msg;
  el("status").className = err ? "err" : "ok";
};
const verify = (): UnlockFactor => ({ kind: "password", password: input("password").value });
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

// Init is async — the listener registrations below attach synchronously so an early click is
// queued behind boot instead of dropped; each handler awaits the promise it needs.
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  const slot: { fn: ((v: T) => void) | undefined } = { fn: undefined };
  const promise = new Promise<T>((resolve) => {
    slot.fn = resolve;
  });
  const resolve = (v: T): void => {
    slot.fn?.(v);
  };
  return { promise, resolve };
};
const walletD = deferred<Awaited<ReturnType<typeof createWebWallet>>>();
const engineD = deferred<ReturnType<typeof createWalletEngine>>();
const walletP = walletD.promise;
const engineP = engineD.promise;

let walletId = "";
const ref = (engine: Awaited<typeof engineP>): SparkAccountRef => {
  const sel = engine.accounts.getState().selected;
  return { walletId, groupIndex: sel?.groupIndex ?? 0, network: "regtest" };
};
const key = (engine: Awaited<typeof engineP>) => `${walletId}:${ref(engine).groupIndex}:regtest`;

/** Rebuilds the group picker from the account tree and marks the selected group. */
const renderGroups = (engine: Awaited<typeof engineP>): void => {
  const tree = engine.accounts.getState();
  const picker = pickerEl();
  picker.innerHTML = "";
  for (const w of tree.wallets) {
    for (const g of tree.groups[w.walletId] ?? []) {
      if (!g.hidden) {
        const opt = document.createElement("option");
        opt.value = `${g.index}`;
        opt.textContent = g.name ?? `account ${g.index + 1}`;
        opt.selected = tree.selected !== null && tree.selected.groupIndex === g.index;
        picker.append(opt);
      }
    }
  }
};

const enable = (ids: string[], on: boolean): void => {
  for (const id of ids) {
    button(id).disabled = !on;
  }
};

button("create").addEventListener("click", () => {
  void (async () => {
    try {
      const wallet = await walletP;
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
      const wallet = await walletP;
      await wallet.vault.unlock(verify());
      say("unlocked");
      const engine = await engineP;
      renderGroups(engine);
      enable(["addGroup", "groupPicker"], true);
    } catch (error) {
      say(`unlock failed: ${String(error)}`, true);
    }
  })();
});

button("lock").addEventListener("click", () => {
  void (async () => {
    const wallet = await walletP;
    await wallet.vault.lock();
    el("accountState").textContent = "locked";
    say("locked");
  })();
});

button("addGroup").addEventListener("click", () => {
  void (async () => {
    const engine = await engineP;
    engine.accounts.addGroup(walletId);
    renderGroups(engine);
  })();
});

button("groupPicker").addEventListener("change", () => {
  void (async () => {
    const engine = await engineP;
    engine.accounts.select(walletId, Number(pickerEl().value));
  })();
});

// The engine drives spark.setAccounts on selection; this watch just renders the live account.
const tick = (engine: Awaited<typeof engineP>): void => {
  const s = engine.spark.getState().accounts[key(engine)];
  // With no live Spark account the line shows the tree status — "locked" after lock.
  const state = s?.status ?? engine.accounts.getState().status;
  el("accountState").textContent = state;
  if (s?.sparkAddress !== undefined) {
    input("sparkAddr").value = s.sparkAddress;
    el("balance").textContent = `${s.balanceSats ?? 0} sats`;
    enable(["createInvoice", "payInvoice", "send", "withdrawBtn"], true);
  }
  if (state !== "ready" && state !== "error") {
    setTimeout(() => tick(engine), 500);
  } else if (state === "error") {
    say(`account error: ${errText(s?.errorCategory)}`, true);
  }
};

const action = (
  id: string,
  label: string,
  run: (engine: Awaited<typeof engineP>) => Promise<unknown>,
): void => {
  button(id).addEventListener("click", () => {
    void (async () => {
      say(`${label}…`);
      try {
        const r = await run(await engineP);
        say(`${label}: ${JSON.stringify(r).slice(0, 200)}`);
      } catch (error) {
        say(`${label} failed: ${String(error)}`, true);
      }
    })();
  });
};

action("createInvoice", "invoice", async (engine) => {
  const { invoice } = await engine.spark.createInvoice(ref(engine), {
    amountSats: Number(input("invoiceAmount").value),
  });
  input("invoice").value = invoice;
  return invoice.slice(0, 40);
});
action("payInvoice", "pay", async (engine) =>
  engine.spark.payInvoice(ref(engine), {
    invoice: input("invoice").value,
    maxFeeSats: 100,
    verify: verify(),
  }),
);
action("send", "send", async (engine) =>
  engine.spark.send(ref(engine), {
    receiver: input("invoice").value,
    amountSats: Number(input("invoiceAmount").value),
    verify: verify(),
  }),
);
action("withdrawBtn", "withdraw", async (engine) => {
  const amt = input("withdrawAmount").value.trim();
  return engine.spark.withdraw(ref(engine), {
    address: input("l1addr").value,
    speed: "MEDIUM",
    ...(amt.length === 0 ? {} : { amountSats: Number(amt) }),
    verify: verify(),
  });
});

// Boot resolves the deferreds; every handler registered above queues behind these promises.
try {
  const wallet = await createWebWallet({
    passkey: {
      rpId: "localhost",
      rpName: "qntx playground",
      walletSalt: "qntx/wallet",
      vaultSalt: "qntx/vault",
      backupSalt: "qntx/backup",
    },
    autoLock: { platform: "web", idleMinutes: 15 },
  });
  walletD.resolve(wallet);
  engineD.resolve(
    createWalletEngine({
      wallet,
      sparkNetwork: "regtest",
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
    }),
  );
  const engine = await engineP;
  engine.accounts.store.subscribe(() => renderGroups(engine));
  engine.accounts.store.subscribe(() => tick(engine));
} catch (error) {
  el("error").textContent = `wallet init failed: ${String(error)}`;
  throw error instanceof Error ? error : new Error(String(error));
}
