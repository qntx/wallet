/**
 * The EIP-1193/EIP-6963 provider injected into an in-app browser WebView. Self-contained ES2020 —
 * no imports, no wallet state. The build wraps this module in an IIFE bound to `qntxProvider`;
 * `injectedScript(info)` appends one `qntxProvider.install(<JSON>)` call. Page to host:
 * `ReactNativeWebView.postMessage` of `{ qntx: 1, id, method, params? }`. Host to page:
 * `__qntxReceive(<JSON>)` carrying `{ id, result }`, `{ id, error: { code, message } }` or `{
 * event, data }`. `__qntxReceive` is defined as a non-writable, non-configurable property so a
 * hostile page cannot replace the host's reply channel.
 */
import type {
  SolanaSignAndSendTransactionFeature,
  SolanaSignInFeature,
  SolanaSignInOutput,
  SolanaSignMessageFeature,
  SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import type { IdentifierString, Wallet, WalletAccount, WalletIcon } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";
import { registerWallet } from "@wallet-standard/wallet";

/**
 * The Bitcoin Wallet Standard features, as Exodus defines them
 * (ExodusMovement/bitcoin-wallet-standard `packages/core/features/src`: connect, signMessage; the
 * `bitcoin:disconnect` / `bitcoin:events` pair as in MetaMask's
 * `@metamask/bitcoin-wallet-standard`). Declared here, only the shapes this wallet implements: the
 * upstream features package is a 2023 0.0.1 release that has no disconnect or events feature, so a
 * local copy of three small types avoids a dependency that would not cover the surface anyway.
 */
type BitcoinPurpose = "payment" | "ordinals";
type BitcoinConnectFeature = {
  readonly "bitcoin:connect": {
    readonly version: "1.0.0";
    readonly connect: (input: {
      readonly purposes: BitcoinPurpose[];
    }) => Promise<{ readonly accounts: ReadonlyArray<WalletAccount> }>;
  };
};
type BitcoinDisconnectFeature = {
  readonly "bitcoin:disconnect": {
    readonly version: "1.0.0";
    readonly disconnect: () => Promise<void>;
  };
};
type BitcoinEventsFeature = {
  readonly "bitcoin:events": {
    readonly version: "1.0.0";
    readonly on: (
      event: "change",
      listener: (properties: { readonly accounts?: ReadonlyArray<WalletAccount> }) => void,
    ) => () => void;
  };
};
type BitcoinSignMessageFeature = {
  readonly "bitcoin:signMessage": {
    readonly version: "1.0.0";
    readonly signMessage: (
      ...inputs: ReadonlyArray<{ readonly account: WalletAccount; readonly message: Uint8Array }>
    ) => Promise<
      ReadonlyArray<{ readonly signedMessage: Uint8Array; readonly signature: Uint8Array }>
    >;
  };
};

type BitcoinSigHash =
  | "ALL"
  | "NONE"
  | "SINGLE"
  | "ALL|ANYONECANPAY"
  | "NONE|ANYONECANPAY"
  | "SINGLE|ANYONECANPAY";
type BitcoinSignInput = {
  readonly psbt: Uint8Array;
  readonly inputsToSign: ReadonlyArray<{
    readonly account: WalletAccount;
    readonly signingIndexes: number[];
    readonly sigHash?: BitcoinSigHash;
  }>;
  readonly chain?: IdentifierString;
};
type BitcoinSignTransactionFeature = {
  readonly "bitcoin:signTransaction": {
    readonly version: "1.0.0";
    readonly signTransaction: (
      ...inputs: ReadonlyArray<BitcoinSignInput>
    ) => Promise<ReadonlyArray<{ readonly signedPsbt: Uint8Array }>>;
  };
};
type BitcoinSignAndSendTransactionFeature = {
  readonly "bitcoin:signAndSendTransaction": {
    readonly version: "1.0.0";
    readonly signAndSendTransaction: (
      ...inputs: ReadonlyArray<BitcoinSignInput & { readonly chain: IdentifierString }>
    ) => Promise<ReadonlyArray<{ readonly txId: string }>>;
  };
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const bytesReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? { __bytes: bytesToHex(value) } : value;

const isBytesEnvelope = (v: unknown): v is { __bytes: string } =>
  typeof v === "object" && v !== null && typeof (v as { __bytes?: unknown }).__bytes === "string";

const bytesReviver = (_key: string, value: unknown): unknown =>
  isBytesEnvelope(value) ? hexToBytes(value.__bytes) : value;

const isWalletIcon = (value: string): value is WalletIcon =>
  /^data:image\/(?:svg\+xml|webp|png|gif);base64,/.test(value);

type ProviderInfo = {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
};

type RequestArguments = { readonly method: string; readonly params?: unknown };

type Listener = (payload: unknown) => void;

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
};

/** The page globals this script reads; `globalThis` is assignable as each one is optional. */
type PageGlobal = typeof globalThis & {
  readonly ReactNativeWebView?: { readonly postMessage: (message: string) => void };
};

const page: PageGlobal = globalThis;

const EVENT_ANNOUNCE = "eip6963:announceProvider";
const EVENT_REQUEST = "eip6963:requestProvider";

/** EIP-1193 `ProviderRpcError`. */
class ProviderRpcError extends Error {
  override name = "ProviderRpcError";
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The host's `{ code, message }` as a ProviderRpcError; anything else is an internal error. */
const errorOf = (value: unknown): ProviderRpcError =>
  isRecord(value) && typeof value["code"] === "number" && typeof value["message"] === "string"
    ? new ProviderRpcError(value["code"], value["message"])
    : new ProviderRpcError(-32603, "internal error");

/** The wire shape of Bitcoin sign inputs: accounts travel as their addresses. */
const btcInputs = (inputs: ReadonlyArray<BitcoinSignInput>): unknown =>
  inputs.map((input) => ({
    psbt: input.psbt,
    chain: input.chain,
    inputsToSign: input.inputsToSign.map((item) => ({
      address: item.account.address,
      signingIndexes: item.signingIndexes,
      sigHash: item.sigHash,
    })),
  }));

const unsupported = async (): Promise<never> => {
  await Promise.resolve();
  throw new Error("NotSupported");
};

/**
 * Installs `window.ethereum` (EIP-1193) and the EIP-6963 announcer for `info`. `id` increments per
 * request; the pending map settles on the host's reply.
 */
export function install(info: ProviderInfo): void {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<Listener>>();

  const emit = (name: string, payload: unknown): void => {
    for (const listener of listeners.get(name) ?? []) {
      try {
        listener(payload);
      } catch {
        // A listener that throws must not break the others.
      }
    }
  };

  const request = async (provider: string, args: RequestArguments): Promise<unknown> => {
    if (!isRecord(args) || typeof args.method !== "string" || args.method.length === 0) {
      throw new ProviderRpcError(-32602, "request({ method, params? }) requires a method string");
    }
    const id = nextId;
    nextId += 1;
    const reply = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    page.ReactNativeWebView?.postMessage(
      JSON.stringify(
        { qntx: 1, provider, id, method: args.method, params: args.params },
        bytesReplacer,
      ),
    );
    return reply;
  };

  const on = (name: string, listener: Listener): void => {
    const set = listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(name, set);
  };

  const removeListener = (name: string, listener: Listener): void => {
    listeners.get(name)?.delete(listener);
  };

  // `window.ethereum` exposes only `request`/`on`/`removeListener` — no `isMetaMask`, `enable`,
  // `send` or `sendAsync` (no impersonation, no deprecated surface).
  const provider = Object.freeze({
    request: async (args: RequestArguments): Promise<unknown> => {
      const result = await request("eip1193", args);
      return result;
    },
    on,
    removeListener,
  });

  // NIP-07: the same pending/receive machinery, `provider: "nostr"` on the wire.
  const nostr = Object.freeze({
    getPublicKey: async () => {
      const result = await request("nostr", { method: "getPublicKey" });
      return result;
    },
    signEvent: async (event: unknown) => {
      const result = await request("nostr", { method: "signEvent", params: [event] });
      return result;
    },
    nip04: Object.freeze({
      encrypt: async (pubkey: string, plaintext: string) => {
        const result = await request("nostr", {
          method: "nip04.encrypt",
          params: [pubkey, plaintext],
        });
        return result;
      },
      decrypt: async (pubkey: string, ciphertext: string) => {
        const result = await request("nostr", {
          method: "nip04.decrypt",
          params: [pubkey, ciphertext],
        });
        return result;
      },
    }),
    nip44: Object.freeze({
      encrypt: async (pubkey: string, plaintext: string) => {
        const result = await request("nostr", {
          method: "nip44.encrypt",
          params: [pubkey, plaintext],
        });
        return result;
      },
      decrypt: async (pubkey: string, ciphertext: string) => {
        const result = await request("nostr", {
          method: "nip44.decrypt",
          params: [pubkey, ciphertext],
        });
        return result;
      },
    }),
  });

  // WebLN: the same machinery, `provider: "webln"`. keysend/signMessage/verifyMessage/request
  // reject in-page (they never reach the bridge) — the wallet does not support them.
  const webln = Object.freeze({
    enable: async () => {
      const result = await request("webln", { method: "enable" });
      return result;
    },
    getInfo: async () => {
      const result = await request("webln", { method: "getInfo" });
      return result;
    },
    sendPayment: async (invoice: string) => {
      const result = await request("webln", { method: "sendPayment", params: invoice });
      return result;
    },
    makeInvoice: async (args: unknown) => {
      const result = await request("webln", { method: "makeInvoice", params: args });
      return result;
    },
    lnurl: async (lnurl: string) => {
      const result = await request("webln", { method: "lnurl", params: lnurl });
      return result;
    },
    getBalance: async () => {
      const result = await request("webln", { method: "getBalance" });
      return result;
    },
    keysend: unsupported,
    signMessage: unsupported,
    verifyMessage: unsupported,
    request: unsupported,
  });

  const receive = (json: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(json, bytesReviver);
    } catch {
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    const { id, event } = message;
    if (typeof id === "number") {
      const settle = pending.get(id);
      pending.delete(id);
      if (settle !== undefined) {
        if ("error" in message) {
          settle.reject(errorOf(message["error"]));
        } else {
          settle.resolve(message["result"]);
        }
      }
      return;
    }
    if (typeof event === "string") {
      emit(event, message["data"]);
    }
  };

  // The host's only channel into the page: replies settle by id, events fan out to listeners.
  Object.defineProperty(globalThis, "__qntxReceive", {
    value: receive,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, "ethereum", {
    value: provider,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, "nostr", {
    value: nostr,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, "webln", {
    value: webln,
    writable: false,
    configurable: false,
  });

  // Wallet Standard (Solana): the same machinery, `provider: "solana"`. The wallet is registered
  // into the page's `getWallets()` registry rather than exposed as a global.
  const wsAccounts: WalletAccount[] = [];
  const setAccounts = (accounts: ReadonlyArray<WalletAccount>): void => {
    wsAccounts.length = 0;
    wsAccounts.push(...accounts);
  };
  const signTransactions = async (
    method: string,
    inputs: ReadonlyArray<{
      readonly account: WalletAccount;
      readonly transaction: Uint8Array;
      readonly chain?: string | undefined;
    }>,
  ): Promise<unknown> =>
    request("solana", {
      method,
      params: {
        transactions: inputs.map((input) => input.transaction),
        accounts: inputs.map((input) => input.account.address),
        chains: inputs.map((input) => input.chain),
      },
    });
  const wsFeatures: StandardConnectFeature &
    StandardDisconnectFeature &
    StandardEventsFeature &
    SolanaSignTransactionFeature &
    SolanaSignAndSendTransactionFeature &
    SolanaSignMessageFeature &
    SolanaSignInFeature = {
    "standard:connect": {
      version: "1.0.0",
      connect: async (input) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        const result = (await request("solana", {
          method: "standard:connect",
          params: input,
        })) as { accounts: WalletAccount[] };
        setAccounts(result.accounts);
        return { accounts: [...wsAccounts] };
      },
    },
    "standard:disconnect": {
      version: "1.0.0",
      disconnect: async () => {
        await request("solana", { method: "standard:disconnect" });
        setAccounts([]);
      },
    },
    "standard:events": {
      version: "1.0.0",
      on: (event, cb) => {
        const listener = (data: unknown): void => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's event shape
          const d = data as { event?: string; params?: { accounts?: WalletAccount[] } };
          if (d.event === event) {
            setAccounts(d.params?.accounts ?? []);
            cb({ accounts: [...wsAccounts] });
          }
        };
        on("standard:events", listener);
        return () => {
          removeListener("standard:events", listener);
        };
      },
    },
    "solana:signTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        const result = (await signTransactions("solana:signTransaction", inputs)) as {
          signedTransactions: Uint8Array[];
        };
        return result.signedTransactions.map((signedTransaction) => ({ signedTransaction }));
      },
    },
    "solana:signAndSendTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signAndSendTransaction: async (...inputs) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        const result = (await signTransactions("solana:signAndSendTransaction", inputs)) as {
          signatures: Uint8Array[];
        };
        return result.signatures.map((signature) => ({ signature }));
      },
    },
    "solana:signMessage": {
      version: "1.0.0",
      signMessage: async (...inputs) => {
        if (inputs.length !== 1 || inputs[0] === undefined) {
          throw new Error("solana:signMessage accepts one input at a time");
        }
        const [input] = inputs;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        const result = (await request("solana", {
          method: "solana:signMessage",
          params: { message: input.message, accounts: [input.account.address] },
        })) as { signature: Uint8Array; signedMessage: Uint8Array };
        return [
          {
            signedMessage: result.signedMessage,
            signature: result.signature,
            signatureType: "ed25519",
          },
        ];
      },
    },
    "solana:signIn": {
      version: "1.0.0",
      signIn: async (...inputs) => {
        if (inputs.length > 1) {
          throw new Error("solana:signIn accepts one input at a time");
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        return (await request("solana", {
          method: "solana:signIn",
          params: { input: inputs[0] ?? {} },
        })) as SolanaSignInOutput[];
      },
    },
  };
  if (!isWalletIcon(info.icon)) {
    throw new Error("the provider icon is not a data URI image");
  }
  const wsWallet: Wallet = Object.freeze({
    version: "1.0.0",
    name: info.name,
    icon: info.icon,
    chains: Object.freeze<IdentifierString[]>(["solana:mainnet", "solana:devnet"]),
    features: Object.freeze(wsFeatures),
    get accounts(): ReadonlyArray<WalletAccount> {
      return wsAccounts;
    },
  });
  registerWallet(wsWallet);

  // Wallet Standard (Bitcoin): the same machinery, `provider: "bitcoin"`; `standard:disconnect`
  // and `bitcoin:disconnect` both end the session.
  const btcAccounts: WalletAccount[] = [];
  const setBtcAccounts = (accounts: ReadonlyArray<WalletAccount>): void => {
    btcAccounts.length = 0;
    btcAccounts.push(...accounts);
  };
  const btcDisconnect = async (): Promise<void> => {
    await request("bitcoin", { method: "standard:disconnect" });
    setBtcAccounts([]);
  };
  const btcFeatures: StandardDisconnectFeature &
    BitcoinConnectFeature &
    BitcoinDisconnectFeature &
    BitcoinEventsFeature &
    BitcoinSignMessageFeature &
    BitcoinSignTransactionFeature &
    BitcoinSignAndSendTransactionFeature = {
    "standard:disconnect": { version: "1.0.0", disconnect: btcDisconnect },
    "bitcoin:connect": {
      version: "1.0.0",
      connect: async (input) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        const result = (await request("bitcoin", {
          method: "bitcoin:connect",
          params: input,
        })) as { accounts: WalletAccount[] };
        setBtcAccounts(result.accounts);
        return { accounts: [...btcAccounts] };
      },
    },
    "bitcoin:disconnect": { version: "1.0.0", disconnect: btcDisconnect },
    "bitcoin:events": {
      version: "1.0.0",
      on: (event, cb) => {
        const listener = (data: unknown): void => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's event shape
          const d = data as { event?: string; params?: { accounts?: WalletAccount[] } };
          if (d.event === event) {
            setBtcAccounts(d.params?.accounts ?? []);
            cb({ accounts: [...btcAccounts] });
          }
        };
        on("bitcoin:events", listener);
        return () => {
          removeListener("bitcoin:events", listener);
        };
      },
    },
    "bitcoin:signMessage": {
      version: "1.0.0",
      signMessage: async (...inputs) => {
        if (inputs.length !== 1 || inputs[0] === undefined) {
          throw new Error("bitcoin:signMessage accepts one input at a time");
        }
        const [input] = inputs;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        const result = (await request("bitcoin", {
          method: "bitcoin:signMessage",
          params: { account: input.account.address, message: input.message },
        })) as { signedMessage: Uint8Array; signature: Uint8Array };
        return [{ signedMessage: result.signedMessage, signature: result.signature }];
      },
    },
    "bitcoin:signTransaction": {
      version: "1.0.0",
      signTransaction: async (...inputs) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        return (await request("bitcoin", {
          method: "bitcoin:signTransaction",
          params: { inputs: btcInputs(inputs) },
        })) as Array<{ signedPsbt: Uint8Array }>;
      },
    },
    "bitcoin:signAndSendTransaction": {
      version: "1.0.0",
      signAndSendTransaction: async (...inputs) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's shape
        return (await request("bitcoin", {
          method: "bitcoin:signAndSendTransaction",
          params: { inputs: btcInputs(inputs) },
        })) as Array<{ txId: string }>;
      },
    },
  };
  const btcWallet: Wallet = Object.freeze({
    version: "1.0.0",
    name: info.name,
    icon: info.icon,
    chains: Object.freeze<IdentifierString[]>(["bitcoin:mainnet", "bitcoin:testnet"]),
    features: Object.freeze(btcFeatures),
    get accounts(): ReadonlyArray<WalletAccount> {
      return btcAccounts;
    },
  });
  registerWallet(btcWallet);

  // EIP-6963: announce at install and on every requestProvider, with a frozen { info, provider }.
  const detail = Object.freeze({ info: Object.freeze({ ...info }), provider });
  const announce = (): void => {
    globalThis.dispatchEvent(new CustomEvent(EVENT_ANNOUNCE, { detail }));
  };
  announce();
  globalThis.addEventListener(EVENT_REQUEST, announce);
}
