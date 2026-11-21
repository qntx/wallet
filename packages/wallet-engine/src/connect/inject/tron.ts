/**
 * The TRON provider surface for the in-app browser: `window.tron`, `window.tronLink` and
 * `window.tronWeb`, a TIP-6963 announcer, and `provider: "tron"` on the shared request/receive
 * channel. Deliberately a minimal TronWeb-compatible object — measured dApp usage (SUN.io etc.)
 * only needs provider state, `trx.sign`, `signMessageV2`, `_signTypedData`, `sendRawTransaction`
 * and `getBlockByNumber(0)`; every other member is a recursive 4200 stub so a dApp that reaches for
 * more fails loudly instead of silently misbehaving.
 */

type ProviderInfo = {
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
};

type RequestArguments = { readonly method: string; readonly params?: unknown };

type Listener = (payload: unknown) => void;

/** The machinery `install()` shares with this module. */
export type TronInstallContext = {
  readonly request: (provider: string, args: RequestArguments) => Promise<unknown>;
  readonly on: (name: string, listener: Listener) => void;
  readonly removeListener: (name: string, listener: Listener) => void;
  readonly emit: (name: string, payload: unknown) => void;
  /** The document id — the TIP-6963 `info.uuid`, one per document. */
  readonly doc: string;
  readonly info: ProviderInfo;
  /** The install global (`globalThis` in the page; injectable for tests). */
  readonly global: {
    readonly dispatchEvent: (event: Event) => boolean;
    readonly addEventListener: (name: string, listener: () => void) => void;
    readonly CustomEvent: new (name: string, init: { readonly detail: unknown }) => Event;
  };
};

/** EIP-1193 `ProviderRpcError`. */
class ProviderRpcError extends Error {
  override name = "ProviderRpcError";
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type TronAddress = { readonly base58: string; readonly hex: string };

/** The `tron_getProviderState` / `tronStateChanged` payload the host sends. */
type TronProviderState = {
  readonly address: TronAddress | false;
  readonly chainId: string;
  readonly genesis: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isProviderState = (v: unknown): v is TronProviderState =>
  isRecord(v) &&
  (v["address"] === false ||
    (isRecord(v["address"]) &&
      typeof v["address"]["base58"] === "string" &&
      typeof v["address"]["hex"] === "string")) &&
  typeof v["chainId"] === "string" &&
  typeof v["genesis"] === "string";

const textEncoder = new TextEncoder();

/**
 * A member the wallet does not implement: any string key resolves to another refusal function, and
 * calling one throws 4200. `then`/`toJSON`/symbols and `is*` flags resolve `undefined` so the stub
 * is never thenable, never serializes, and never pretends to be another wallet.
 */
const refuse = (path: string): unknown =>
  new Proxy(() => undefined, {
    get: (_target, prop) => {
      if (
        prop === "then" ||
        prop === "toJSON" ||
        typeof prop === "symbol" ||
        prop.startsWith("is")
      ) {
        return undefined;
      }
      return refuse(`${path}.${prop}`);
    },
    apply: () => {
      throw new ProviderRpcError(4200, `tronWeb.${path} is not supported by this wallet`);
    },
  });

/** Wraps an implemented object: its own members win, every other string key refuses. */
const stub = (path: string, base: Record<string, unknown>): unknown =>
  new Proxy(base, {
    get: (target, prop) => {
      if (prop === "then" || prop === "toJSON" || typeof prop === "symbol") {
        return undefined;
      }
      return prop in target
        ? target[prop]
        : prop.startsWith("is")
          ? undefined
          : refuse(`${path}.${prop}`);
    },
  });

/** `signMessageV2` accepts a UTF-8 string, Uint8Array bytes, or a plain number array. */
const messageBytes = (message: unknown): Uint8Array => {
  if (typeof message === "string") {
    return textEncoder.encode(message);
  }
  if (message instanceof Uint8Array) {
    return message;
  }
  if (Array.isArray(message) && message.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Uint8Array.from(message);
  }
  throw new ProviderRpcError(-32602, "signMessageV2 needs a string or bytes");
};

export function installTron(ctx: TronInstallContext): void {
  const { request, on, removeListener, emit, doc, info, global } = ctx;
  let address: TronAddress | false = false;
  let chainId = "0x0";
  let genesis = "";

  const connected = (): boolean => address !== false;

  const trx = stub("trx", {
    sign: async (tx: unknown) => {
      if (typeof tx === "string") {
        throw new ProviderRpcError(4200, "trx.sign(hex) signs a raw digest — use signMessageV2");
      }
      if (!isRecord(tx)) {
        throw new ProviderRpcError(-32602, "trx.sign needs a transaction object");
      }
      return request("tron", { method: "tron_signTransaction", params: { transaction: tx } });
    },
    // oxlint-disable-next-line typescript/require-await -- the trx surface is promise-typed
    signMessage: async () => {
      throw new ProviderRpcError(4200, "trx.signMessage is not supported — use signMessageV2");
    },
    // oxlint-disable-next-line typescript/require-await -- the trx surface is promise-typed
    multiSign: async () => {
      throw new ProviderRpcError(4200, "multi-signature is not supported");
    },
    signMessageV2: async (message: unknown) =>
      request("tron", {
        method: "tron_signMessageV2",
        params: { message: messageBytes(message) },
      }),
    _signTypedData: async (domain: unknown, types: unknown, value: unknown) =>
      request("tron", {
        method: "tron_signTypedData",
        params: { domain, types, message: value },
      }),
    signTypedData: async (domain: unknown, types: unknown, value: unknown) =>
      request("tron", {
        method: "tron_signTypedData",
        params: { domain, types, message: value },
      }),
    sendRawTransaction: async (tx: unknown) =>
      request("tron", { method: "tron_sendRawTransaction", params: { transaction: tx } }),
    // The adapter calls getBlockByNumber(0) to learn the genesis id; anything else is out of
    // scope for a signing provider (there is no node to serve arbitrary blocks from).
    getBlockByNumber: async (n: unknown) =>
      n === 0 || n === "0"
        ? Promise.resolve({ blockID: genesis })
        : Promise.reject(
            new ProviderRpcError(
              4200,
              "tronWeb.trx.getBlockByNumber is not supported by this wallet",
            ),
          ),
  });

  const tronWeb = stub("tronWeb", {
    get ready() {
      return connected();
    },
    get defaultAddress() {
      const a = address;
      return a === false ? { base58: false, hex: false } : { base58: a.base58, hex: a.hex };
    },
    request: async (args: RequestArguments) => request("tron", args),
    fullNode: { host: "" },
    solidityNode: { host: "" },
    eventServer: { host: "" },
    setFullNode: () => undefined,
    setSolidityNode: () => undefined,
    setEventServer: () => undefined,
    on,
    removeListener,
    trx,
    transactionBuilder: refuse("transactionBuilder"),
    address: refuse("address"),
    utils: refuse("utils"),
    event: refuse("event"),
    plugin: refuse("plugin"),
  });

  const tronGlobal = Object.freeze({
    request: async (args: RequestArguments) => request("tron", args),
    on,
    removeListener,
    get tronWeb() {
      return connected() ? tronWeb : false;
    },
  });

  const tronLink = Object.freeze({
    get ready() {
      return connected();
    },
    request: async (args: RequestArguments) => request("tron", args),
    tronWeb,
  });

  /**
   * A new host state: the first connected state is a `connect`, then
   * `accountsChanged`/`addressChanged` track the address and `chainChanged` the network.
   */
  const apply = (state: TronProviderState): void => {
    const nextAddress =
      isRecord(state.address) &&
      typeof state.address.base58 === "string" &&
      typeof state.address.hex === "string"
        ? { base58: state.address.base58, hex: state.address.hex }
        : false;
    const was = address;
    const wasChain = chainId;
    address = nextAddress;
    chainId = typeof state.chainId === "string" ? state.chainId : chainId;
    genesis = typeof state.genesis === "string" ? state.genesis : genesis;
    if (was === false && nextAddress !== false) {
      emit("connect", { chainId });
    }
    if (
      (was === false ? false : was.base58) !== (nextAddress === false ? false : nextAddress.base58)
    ) {
      emit("accountsChanged", nextAddress === false ? [] : [nextAddress.base58]);
      emit(
        "addressChanged",
        nextAddress === false ? { base58: false, hex: false } : { ...nextAddress },
      );
    }
    if (wasChain !== chainId) {
      emit("chainChanged", { chainId });
    }
  };

  // The initial state answers the first getBlockByNumber(0)/defaultAddress read before the page's
  // own calls settle; later states arrive as `{ event: "tron" }` messages on the shared channel.
  void (async () => {
    try {
      const state = await request("tron", { method: "tron_getProviderState" });
      if (isProviderState(state)) {
        apply(state);
      }
    } catch {
      // A failed state read leaves the provider disconnected; later events still apply.
    }
  })();
  on("tron", (state) => {
    if (isProviderState(state)) {
      apply(state);
    }
  });

  Object.defineProperty(global, "tron", {
    value: tronGlobal,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(global, "tronLink", {
    value: tronLink,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(global, "tronWeb", {
    value: tronWeb,
    writable: false,
    configurable: false,
  });

  // TIP-6963: announce at install and on every requestProvider, provider = window.tron; the uuid
  // is this document's id, like the EIP-6963 announcement.
  const detail = Object.freeze({
    info: Object.freeze({ ...info, uuid: doc }),
    provider: tronGlobal,
  });
  const announce = (): void => {
    global.dispatchEvent(new global.CustomEvent("TIP6963:announceProvider", { detail }));
  };
  announce();
  global.addEventListener("TIP6963:requestProvider", announce);
}
