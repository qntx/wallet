import { verifyEvent } from "@qntx/nostr";
import type { UnlockFactor, VerifyFactor } from "@qntx/wallet";
import { createWalletEngine, requiredAcknowledgement } from "@qntx/wallet-engine";
import type { PaymentOption, PendingRequest } from "@qntx/wallet-engine";
import { openIndexedDbEngineStore, openIndexedDbPublicStore } from "@qntx/wallet-engine/idb";
import type {
  WalletConnect,
  WalletConnectProposal,
  WalletConnectStorage,
} from "@qntx/wallet-engine/walletconnect";
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
const verify = (): VerifyFactor => ({ kind: "password", password: input("password").value });
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

button("passkeyCreate").addEventListener("click", () => {
  void (async () => {
    try {
      const wallet = await walletP;
      const created = await wallet.wallets.createWithPasskey({ name: "qntx playground" });
      ({ walletId } = created);
      say(`passkey wallet ${walletId} created — unlock to connect`);
    } catch (error) {
      say(`passkey create failed: ${String(error)}`, true);
    }
  })();
});

button("passkeyRestore").addEventListener("click", () => {
  void (async () => {
    try {
      const wallet = await walletP;
      const restored = await wallet.wallets.restoreWithPasskey();
      ({ walletId } = restored);
      say(`passkey wallet ${walletId} restored — unlock to connect`);
    } catch (error) {
      say(`passkey restore failed: ${String(error)}`, true);
    }
  })();
});

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
/** Prepares a payment request and approves it at once — the playground has no review screen. */
const payNow = async (
  engine: Awaited<typeof engineP>,
  option: PaymentOption,
  extra: { amountSats?: number; maxFeeSats?: number; speed?: "FAST" | "MEDIUM" | "SLOW" },
) => {
  const request = await engine.requests.prepare({
    method: "pay",
    account: ref(engine),
    option,
    ...extra,
  });
  return engine.requests.approve(request.id, "pay", { verify: verify() });
};
action("payInvoice", "pay", async (engine) => {
  const parsed = engine.payments.parse(input("invoice").value, ref(engine).network);
  const option = parsed.kind === "request" ? parsed.request.options[0] : undefined;
  if (option === undefined) {
    throw new Error("not a payable invoice");
  }
  return payNow(engine, option, { maxFeeSats: 100 });
});
action("send", "send", async (engine) =>
  payNow(
    engine,
    { kind: "spark", address: input("invoice").value },
    { amountSats: Number(input("invoiceAmount").value) },
  ),
);
action("withdrawBtn", "withdraw", async (engine) => {
  const amt = input("withdrawAmount").value.trim();
  return payNow(
    engine,
    { kind: "bitcoin", address: input("l1addr").value },
    { speed: "MEDIUM", ...(amt.length === 0 ? {} : { amountSats: Number(amt) }) },
  );
});

// --- walletconnect: created on the first Pair click, so the page loads without any WC network. ---
const envProjectId: unknown = import.meta.env["VITE_WALLETCONNECT_PROJECT_ID"];
input("wcProjectId").value = typeof envProjectId === "string" ? envProjectId : "";

const WC_PREFIX = "wc.";
const readKey = (key: string): unknown => {
  const raw = localStorage.getItem(`${WC_PREFIX}${key}`);
  return raw === null ? undefined : (JSON.parse(raw) as unknown);
};
const wcKeys = (): string[] =>
  Object.keys(localStorage)
    .filter((key) => key.startsWith(WC_PREFIX))
    .map((key) => key.slice(WC_PREFIX.length));
/* oxlint-disable typescript/require-await -- the storage contract is async; localStorage is synchronous */
const wcStorage: WalletConnectStorage = {
  getKeys: async () => wcKeys(),
  getEntries: async () => wcKeys().map((key): [string, unknown] => [key, readKey(key)]),
  getItem: async (key) => readKey(key),
  setItem: async (key, value) => {
    localStorage.setItem(`${WC_PREFIX}${key}`, JSON.stringify(value));
  },
  removeItem: async (key) => {
    localStorage.removeItem(`${WC_PREFIX}${key}`);
  },
};
/* oxlint-enable typescript/require-await */

const wcD = deferred<WalletConnect>();
const wcP = wcD.promise;
let wcStarted = false;
const startWc = async (projectId: string): Promise<WalletConnect> => {
  const { createWalletConnect } = await import("@qntx/wallet-engine/walletconnect");
  const wc = await createWalletConnect({
    projectId,
    metadata: {
      name: "qntx playground",
      description: "qntx spark playground",
      url: location.origin,
      icons: [],
    },
    storage: wcStorage,
    wallet: await walletP,
    engine: await engineP,
    now: () => Date.now(),
    logger: { warn: (m: string, e?: unknown) => void [m, e] },
  });
  wcStarted = true;
  wc.store.subscribe(() => renderWcProposals(wc));
  wcD.resolve(wc);
  return wc;
};

const renderWcProposals = (wc: WalletConnect): void => {
  const box = el("wcProposals");
  box.innerHTML = "";
  for (const p of Object.values(wc.getState().proposals)) {
    const row = document.createElement("div");
    const risk =
      p.risk.length === 0 ? "none" : p.risk.map((f) => `${f.level}:${f.code}`).join(", ");
    row.textContent =
      `proposal ${p.id}: ${p.peer.name} <${p.peer.url}> ` +
      `verify=${p.verify.validation}${p.verify.isScam ? " scam" : ""} risk=${risk} ` +
      `nets=${p.networks.join(" ")}`;
    const approve = document.createElement("button");
    approve.textContent = "approve";
    approve.addEventListener("click", () => {
      void approveWcProposal(wc, p);
    });
    const reject = document.createElement("button");
    reject.textContent = "reject";
    reject.addEventListener("click", () => {
      void (async () => {
        try {
          await wc.reject(p.id);
        } catch (error) {
          say(`reject failed: ${String(error)}`, true);
        }
      })();
    });
    row.append(approve, reject);
    box.append(row);
  }
};

const approveWcProposal = async (wc: WalletConnect, p: WalletConnectProposal): Promise<void> => {
  const danger = p.risk.filter((f) => f.level === "danger").map((f) => f.code);
  // oxlint-disable-next-line eslint/no-alert -- the playground's danger review is a confirm()
  if (danger.length > 0 && !confirm(`danger findings: ${danger.join(", ")} — approve anyway?`)) {
    return;
  }
  say("approving session…");
  try {
    const session = await wc.approve(p.id, {
      networks: [...p.networks],
      acknowledged: danger,
    });
    say(`session ${session.origin.origin}`);
  } catch (error) {
    say(`approve failed: ${String(error)}`, true);
  }
};

const renderWcRequests = (engine: Awaited<typeof engineP>): void => {
  const box = el("wcRequests");
  box.innerHTML = "";
  for (const request of Object.values(engine.requests.getState().requests)) {
    if (request.stage !== "awaiting-approval" || request.origin.kind !== "walletconnect") {
      continue;
    }
    const row = document.createElement("div");
    const { origin } = request;
    row.textContent = `${request.method} from ${origin.name} <${origin.url}>`;
    const approve = document.createElement("button");
    approve.textContent = "approve";
    approve.addEventListener("click", () => {
      void (async () => {
        try {
          await approveWcRequest(engine, request);
          say("approved");
        } catch (error) {
          say(`approve failed: ${String(error)}`, true);
        }
      })();
    });
    const reject = document.createElement("button");
    reject.textContent = "reject";
    reject.addEventListener("click", () => {
      try {
        engine.requests.reject(request.id);
      } catch (error) {
        say(`reject failed: ${String(error)}`, true);
      }
    });
    row.append(approve, reject);
    box.append(row);
  }
};

const approveWcRequest = async (
  engine: Awaited<typeof engineP>,
  request: PendingRequest,
): Promise<unknown> => {
  const options = { verify: verify(), acknowledged: requiredAcknowledgement(request) };
  switch (request.method) {
    case "send":
      return engine.requests.approve(request.id, "send", options);
    case "evm-batch":
      return engine.requests.approve(request.id, "evm-batch", options);
    case "evm-sign":
      return engine.requests.approve(request.id, "evm-sign", options);
    case "solana-sign":
      return engine.requests.approve(request.id, "solana-sign", options);
    case "bitcoin-sign":
      return engine.requests.approve(request.id, "bitcoin-sign", options);
    case "watch-asset":
      return engine.requests.approve(request.id, "watch-asset", options);
    default:
      throw new Error(`the playground cannot approve ${request.method}`);
  }
};

button("wcPair").addEventListener("click", () => {
  void (async () => {
    say("pairing…");
    try {
      const engine = await engineP;
      const parsed = engine.payments.parse(input("wcUri").value.trim(), ref(engine).network);
      if (parsed.kind !== "walletconnect") {
        throw new Error("not a wc: uri");
      }
      const projectId = input("wcProjectId").value.trim();
      if (projectId.length === 0) {
        throw new Error("a reown project id is required");
      }
      const wc = wcStarted ? await wcP : await startWc(projectId);
      await wc.pair(parsed.uri);
      say("paired — waiting for the proposal");
    } catch (error) {
      say(`pair failed: ${String(error)}`, true);
    }
  })();
});

// Boot resolves the deferreds; every handler registered above queues behind these promises.
try {
  const wallet = await createWebWallet({
    verifyEvent,
    passkey: {
      rpId: location.hostname,
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
      verifyEvent,
      wallet,
      sparkNetwork: "regtest",
      fetch: globalThis.fetch.bind(globalThis),
      random,
      now: () => Date.now(),
      weblnAlias: "qntx",
      lightningMaxFee: (amountSats) => Math.max(1, Math.ceil(amountSats / 50)),
      showCallsStatus: () => undefined,
      logger: { warn: (m: string, e?: unknown) => void [m, e] },
      publicStore: await openIndexedDbPublicStore({ name: "playground-public" }),
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
  engine.requests.store.subscribe(() => renderWcRequests(engine));
} catch (error) {
  el("error").textContent = `wallet init failed: ${String(error)}`;
  throw error instanceof Error ? error : new Error(String(error));
}
